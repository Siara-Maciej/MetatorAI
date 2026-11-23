//! The machine as the shell's commands see it (ADR-0105): which `metator` runs, with which PATH and
//! resources, and running it. The decisions are the pure functions of `paths`, `cli` and
//! `envelope`; this only asks the machine.

use crate::cli::{self, Choice, Resolved, Source};
use crate::envelope::{self, ShellError};
use crate::paths;
use crate::store;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub struct Machine {
    /// The folder of the app's own executable: the bundled CLI is there.
    pub exe_dir: PathBuf,
    /// The app's resource folder (Tauri's), which holds `metator-resources`.
    pub resource_dir: Option<PathBuf>,
    /// The app's data folder: `repos.json`, `settings.json`.
    pub data_dir: PathBuf,
    login_path: OnceLock<Option<String>>,
}

const WINDOWS: bool = cfg!(windows);

/// No console window for a program the app starts (Windows).
fn quiet(c: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

impl Machine {
    pub fn new(exe_dir: PathBuf, resource_dir: Option<PathBuf>, data_dir: PathBuf) -> Self {
        Machine {
            exe_dir,
            resource_dir,
            data_dir,
            login_path: OnceLock::new(),
        }
    }

    /// The login shell's PATH, asked once (macOS and Linux); none on Windows, or when the shell does not answer in 5 s.
    fn login_path(&self) -> Option<String> {
        self.login_path
            .get_or_init(|| {
                if WINDOWS {
                    return None;
                }
                let shell = std::env::var("SHELL")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "/bin/sh".to_string());
                let mut child = Command::new(shell)
                    .args(["-ilc", &paths::login_path_script()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .ok()?;
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => break,
                        Ok(None) if Instant::now() < deadline => {
                            std::thread::sleep(Duration::from_millis(25))
                        }
                        _ => {
                            let _ = child.kill();
                            let _ = child.wait();
                            return None;
                        }
                    }
                }
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                paths::parse_login_path(&out)
            })
            .clone()
    }

    /// The PATH every process the app starts gets, the CLI's folder first.
    pub fn path(&self, cli_dir: Option<&Path>) -> String {
        let current = std::env::var("PATH").unwrap_or_default();
        paths::compose_path(cli_dir, self.login_path().as_deref(), &current, WINDOWS)
    }

    pub fn resources(&self) -> Option<PathBuf> {
        self.resource_dir
            .as_ref()
            .map(|d| d.join(paths::RESOURCES_DIR))
            .filter(|d| d.exists())
    }

    pub fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn repos_file(&self) -> PathBuf {
        self.data_dir.join("repos.json")
    }

    pub fn choice(&self) -> Result<Choice, ShellError> {
        store::read_settings(store::read_file(&self.settings_file())?.as_deref())
    }

    /// The `metator` the app runs now.
    pub fn resolve(&self) -> Result<Resolved, ShellError> {
        let sidecar = paths::sidecar(&self.exe_dir, WINDOWS);
        let bundled = sidecar.exists().then_some(sidecar);
        let pathext = std::env::var("PATHEXT").unwrap_or_default();
        let on_path = paths::find_on_path("metator", &self.path(None), WINDOWS, &pathext, |p| {
            p.is_file()
        });
        cli::resolve(
            &self.choice()?,
            std::env::var("METATOR_BIN").ok().as_deref(),
            bundled,
            on_path,
        )
    }

    /// `metator <args>` as the app starts it: the composed PATH, and the resources of the bundled one.
    pub fn command(&self, resolved: &Resolved, args: &[String]) -> Command {
        let (program, all) = paths::invocation(&resolved.program, args);
        let mut c = Command::new(program);
        c.args(all)
            .env("PATH", self.path(resolved.program.parent()));
        if resolved.source == Source::Bundled {
            if let Some(r) = self.resources() {
                c.env("METATOR_RESOURCES", r);
            }
        }
        quiet(&mut c);
        c
    }

    /// Runs `metator <args>` and answers its envelope's data.
    pub fn run(&self, args: &[String]) -> Result<Value, ShellError> {
        self.run_with(&self.resolve()?, args)
    }

    /// Runs this `metator <args>` and answers its envelope's data.
    pub fn run_with(&self, resolved: &Resolved, args: &[String]) -> Result<Value, ShellError> {
        let output = self
            .command(resolved, args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| spawn_error(&resolved.program, e))?;
        envelope::data(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        )
    }

    /// A program other than metator (git) with the same PATH.
    pub fn other(&self, program: &str, args: &[&str]) -> Result<std::process::Output, ShellError> {
        let mut c = Command::new(program);
        c.args(args)
            .env("PATH", self.path(None))
            .stdin(Stdio::null());
        quiet(&mut c);
        c.output().map_err(|e| spawn_error(Path::new(program), e))
    }

    /// Runs `metator <args>`, giving each line it says as it comes (stderr), then its envelope.
    pub fn stream(
        &self,
        args: &[String],
        line: impl Fn(&str) + Send + 'static,
    ) -> Result<(Value, Vec<String>), ShellError> {
        let resolved = self.resolve()?;
        let mut child = self
            .command(&resolved, args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| spawn_error(&resolved.program, e))?;
        let stderr = child.stderr.take();
        let said = std::thread::spawn(move || {
            let mut all = String::new();
            if let Some(err) = stderr {
                for l in BufReader::new(err).lines().map_while(Result::ok) {
                    line(&l);
                    all.push_str(&l);
                    all.push('\n');
                }
            }
            all
        });
        let mut out = String::new();
        if let Some(mut stdout) = child.stdout.take() {
            let _ = stdout.read_to_string(&mut out);
        }
        let _ = child.wait();
        let err = said.join().unwrap_or_default();
        let warnings = envelope::warnings(&out);
        envelope::data(&out, &err).map(|d| (d, warnings))
    }
}

fn spawn_error(program: &Path, e: std::io::Error) -> ShellError {
    ShellError::new("SPAWN", &format!("cannot run {}: {e}", program.display()))
        .hint("Reinstall the app, or choose another metator in Settings.")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A machine whose bundled `metator` is a stand-in that says what it got.
    fn machine(name: &str) -> (Machine, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("metator-runner-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let exe = dir.join("app");
        std::fs::create_dir_all(dir.join("res").join(paths::RESOURCES_DIR)).unwrap();
        std::fs::create_dir_all(&exe).unwrap();
        let cli = paths::sidecar(&exe, false);
        std::fs::write(
            &cli,
            "#!/bin/sh\necho \"first $1\" >&2\necho \"second\" >&2\nprintf '{\"ok\":true,\"data\":{\"args\":\"%s\",\"resources\":\"%s\",\"path\":\"%s\"}}\\n' \"$*\" \"$METATOR_RESOURCES\" \"$PATH\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        (
            Machine::new(exe, Some(dir.join("res")), dir.join("data")),
            dir,
        )
    }

    #[test]
    fn the_bundled_cli_runs_with_its_resources_named_and_its_folder_first_on_path() {
        if std::env::var("METATOR_BIN").is_ok() {
            return; // $METATOR_BIN wins over the bundled one by design
        }
        let (m, dir) = machine("run");
        let data = m
            .run(&["inspect".to_string(), "/w/my shop".to_string()])
            .unwrap();
        assert_eq!(data["args"], "inspect /w/my shop");
        assert_eq!(
            data["resources"],
            dir.join("res")
                .join(paths::RESOURCES_DIR)
                .to_string_lossy()
                .as_ref()
        );
        let path = data["path"].as_str().unwrap().to_string();
        assert!(
            path.starts_with(&format!("{}:", dir.join("app").display())),
            "{path}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_stream_gives_each_line_as_it_comes_then_the_envelope() {
        if std::env::var("METATOR_BIN").is_ok() {
            return;
        }
        let (m, dir) = machine("stream");
        let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = lines.clone();
        let (data, warnings) = m
            .stream(&["setup".to_string()], move |l| {
                seen.lock().unwrap().push(l.to_string())
            })
            .unwrap();
        assert_eq!(*lines.lock().unwrap(), ["first setup", "second"]);
        assert_eq!((data["args"].as_str(), warnings.len()), (Some("setup"), 0));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_program_that_cannot_start_is_a_spawn_error() {
        let (m, dir) = machine("spawn");
        let resolved = Resolved {
            source: Source::Custom,
            program: dir.join("nothing-here"),
        };
        assert_eq!(m.run_with(&resolved, &[]).unwrap_err().code, "SPAWN");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// With the real compiled CLI: `METATOR_TEST_APP_DIR` is a folder with the sidecar `metator` and
    /// `metator-resources` beside it, as `cargo build` lays them out in `target/debug` with the
    /// bundle config (`TAURI_CONFIG`). Run by hand: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn the_real_bundled_cli_inspects_sets_up_commits_and_starts_the_daemon() {
        let app =
            PathBuf::from(std::env::var("METATOR_TEST_APP_DIR").expect("METATOR_TEST_APP_DIR"));
        std::env::set_var("METATOR_NO_REAL_HOSTS", "1");
        let dir = std::env::temp_dir().join(format!("metator-real-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = dir.join("shop");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join(".gitignore"), ".metator/\n").unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "T"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);
        let root = repo.to_string_lossy().to_string();
        let m = Machine::new(app.clone(), Some(app.clone()), dir.join("data"));
        assert_eq!(m.resolve().unwrap().source, Source::Bundled);

        let i = m.run(&cli::inspect_args(&root)).unwrap();
        assert_eq!(
            (i["kind"].as_str(), i["next"].as_str()),
            (Some("repo"), Some("setup"))
        );
        let lines = std::sync::Arc::new(std::sync::Mutex::new(0usize));
        let count = lines.clone();
        let (data, _) = m
            .stream(&cli::setup_args(&root, "claude"), move |_| {
                *count.lock().unwrap() += 1
            })
            .unwrap();
        let written = envelope::written(&data);
        let expected: Vec<String> = i["writes"]["claude"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.as_str().unwrap().to_string())
            .collect();
        assert_eq!(written, expected);
        let commit = m.run(&cli::commit_args(&root, &written)).unwrap();
        assert_eq!(commit["commit"].as_str().map(str::len), Some(40));
        assert_eq!(git(&["log", "-1", "--format=%s"]), "Set up MetatorAI");

        let served = m.run(&crate::daemon::ensure_args(&root)).unwrap();
        let url = crate::daemon::url(&served).unwrap();
        assert!(url.starts_with("http://127.0.0.1:"), "{url}");
        let pid = served["pid"].as_u64().unwrap().to_string();
        let _ = Command::new("kill").arg(&pid).status();

        // The Linux CLI bundle, when this build carries it, is found by the name Docker gives the architecture.
        if app.join(crate::bundle::RESOURCES_DIR).exists() {
            let b = crate::bundle::find(
                Some(&app),
                "amd64",
                |p| std::fs::read_to_string(p).ok(),
                |p| p.is_file(),
            )
            .unwrap();
            let version = m
                .run(&["version".to_string(), "--json".to_string()])
                .unwrap();
            assert_eq!(Some(b.version.as_str()), version["version"].as_str());
            assert!(Path::new(&b.path).is_file());
        }
        std::thread::sleep(Duration::from_millis(500));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
