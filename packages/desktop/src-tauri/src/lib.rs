//! The desktop window (D7, ADR-0078): it shows the Vite bundle, which talks to the local daemon
//! over HTTP and WebSockets; the plugins give it system notifications, a folder picker and a way
//! to open the editor or a shell. No domain logic lives here. The commands below are what a
//! browser tab cannot do (ADR-0101, ADR-0105): run the `metator` the app ships with (or the one the
//! person chose) to inspect a folder, set it up, commit what setup wrote and start its daemon;
//! remember the repositories; install the `metator` command; find the Linux CLI bundle. With a
//! dev container (ADR-0106) they run `metator devcontainer …` instead, which reaches the container
//! through docker or nerdctl, and `open_repo` joins the window to the daemon in the container
//! through a loopback forwarder (`forward`).
//! Every command rejects with `{ code, message, hint }` (`envelope::ShellError`).

mod bundle;
mod cli;
mod daemon;
mod devcontainer;
mod envelope;
pub mod forward;
mod launcher;
mod paths;
mod runner;
mod store;

use cli::{Choice, Source};
use envelope::ShellError;
use runner::Machine;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// What the commands share: the machine, and one writer of the app's files at a time.
struct Shell {
    machine: Machine,
    files: Mutex<()>,
    runs: AtomicU64,
    /// One loopback forwarder per dev container's repository (by its key), kept while the app runs.
    forwarders: Mutex<HashMap<String, forward::Forwarder>>,
}

/// The Linux CLI bundles the app carries (`linux-cli/` in its resources; Windows and macOS builds).
fn bundles(shell: &Shell) -> Option<PathBuf> {
    shell
        .machine
        .resource_dir
        .as_ref()
        .map(|d| d.join(bundle::RESOURCES_DIR))
        .filter(|d| d.exists())
}

/// A round-20 command line, or the same run in the dev container of `container`.
fn inside(shell: &Shell, container: Option<&str>, args: Vec<String>) -> Vec<String> {
    match container {
        Some(c) => devcontainer::run_args(c, bundles(shell).as_deref(), &args),
        None => args,
    }
}

fn run_id(shell: &Shell, what: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!(
        "{what}-{millis}-{}",
        shell.runs.fetch_add(1, Ordering::SeqCst)
    )
}

type Answer<T> = Result<T, ShellError>;

const WINDOWS: bool = cfg!(windows);

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

/// The native folder picker; none when the person cancelled.
#[tauri::command(async)]
fn pick_folder(app: AppHandle) -> Answer<Option<String>> {
    Ok(app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

/// What `metator inspect <path>` found, passed through; in the dev container of `container`, there.
#[tauri::command(async)]
fn inspect_folder(
    shell: State<'_, Shell>,
    path: String,
    container: Option<String>,
) -> Answer<Value> {
    shell.machine.run(&inside(
        &shell,
        container.as_deref(),
        cli::inspect_args(&path),
    ))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupOutput {
    run_id: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupDone {
    run_id: String,
    ok: bool,
    written: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ShellError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunId {
    run_id: String,
}

/// Starts `metator -C <path> setup --host <host> --yes` and answers at once; its lines come as
/// `setup://output`, its end as `setup://done` with the files it wrote.
#[tauri::command(async)]
fn run_setup(
    app: AppHandle,
    shell: State<'_, Shell>,
    path: String,
    host: String,
    container: Option<String>,
) -> Answer<RunId> {
    let run_id = run_id(&shell, "setup");
    let args = inside(&shell, container.as_deref(), cli::setup_args(&path, &host));
    let (id, handle) = (run_id.clone(), app.clone());
    std::thread::spawn(move || {
        let say = |app: &AppHandle, line: &str| {
            let _ = app.emit(
                "setup://output",
                SetupOutput {
                    run_id: id.clone(),
                    line: line.to_string(),
                },
            );
        };
        let (out_app, out_id) = (handle.clone(), id.clone());
        let shell = handle.state::<Shell>();
        let done = match shell.machine.stream(&args, move |l| {
            let _ = out_app.emit(
                "setup://output",
                SetupOutput {
                    run_id: out_id.clone(),
                    line: l.to_string(),
                },
            );
        }) {
            Ok((data, warnings)) => {
                for line in envelope::setup_summary(&data, &warnings) {
                    say(&handle, &line);
                }
                SetupDone {
                    run_id: id.clone(),
                    ok: true,
                    written: envelope::written(&data),
                    error: None,
                }
            }
            Err(e) => SetupDone {
                run_id: id.clone(),
                ok: false,
                written: vec![],
                error: Some(e),
            },
        };
        let _ = handle.emit("setup://done", done);
    });
    Ok(RunId { run_id })
}

/// `git init` in a folder that is not a repository (the person's click); in the container's when given.
#[tauri::command(async)]
fn git_init(shell: State<'_, Shell>, path: String, container: Option<String>) -> Answer<()> {
    if let Some(c) = container {
        let data = shell.machine.run(&devcontainer::git_init_args(&c, &path))?;
        return devcontainer::git_init_result(&data);
    }
    let out = shell.machine.other("git", &["-C", &path, "init"])?;
    if out.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(ShellError::new(
        "COMMAND_FAILED",
        &format!("git init failed: {said}"),
    ))
}

/// `metator -C <path> setup --commit --files <files…>`: exactly these, as "Set up MetatorAI".
#[tauri::command(async)]
fn commit_setup(
    shell: State<'_, Shell>,
    path: String,
    files: Vec<String>,
    container: Option<String>,
) -> Answer<Value> {
    shell.machine.run(&inside(
        &shell,
        container.as_deref(),
        cli::commit_args(&path, &files),
    ))
}

fn repos(shell: &Shell) -> Answer<Vec<store::KnownRepo>> {
    store::read_repos(store::read_file(&shell.machine.repos_file())?.as_deref())
}

#[tauri::command(async)]
fn known_repos(shell: State<'_, Shell>) -> Answer<Vec<store::KnownRepo>> {
    repos(&shell)
}

fn now() -> String {
    store::iso8601(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    )
}

/// Remembers a repository or a folder of them; one already known is answered as it was. With
/// `container`: the repository at `path` in that dev container, known by its local folder label.
#[tauri::command(async)]
fn add_repo(
    shell: State<'_, Shell>,
    path: String,
    container: Option<String>,
) -> Answer<store::KnownRepo> {
    if let Some(c) = container {
        let list = shell.machine.run(&devcontainer::list_args())?;
        let found = devcontainer::listed(&list, &c)?;
        let text = |k: &str| found.get(k).and_then(Value::as_str).map(str::to_string);
        let known = store::KnownDevContainer {
            local_folder: c.clone(),
            workspace_folder: path,
            config_file: text("configFile"),
            editor_uri: text("editorUri").unwrap_or_default(),
        };
        let _one = shell
            .files
            .lock()
            .map_err(|_| ShellError::new("IO", "the app's files are locked"))?;
        let (all, entry) = store::add_devcontainer(&repos(&shell)?, known, &now());
        store::write_file(&shell.machine.repos_file(), &store::write_repos(&all))?;
        return Ok(entry);
    }
    let dir = Path::new(&path);
    let children: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default();
    let kind = store::kind_of(dir, &children, |p| p.exists())?;
    let _one = shell
        .files
        .lock()
        .map_err(|_| ShellError::new("IO", "the app's files are locked"))?;
    let (all, entry) = store::add(&repos(&shell)?, &path, kind, &now());
    store::write_file(&shell.machine.repos_file(), &store::write_repos(&all))?;
    Ok(entry)
}

/// Forgets a repository; its files are never touched.
#[tauri::command(async)]
fn remove_repo(shell: State<'_, Shell>, path: String) -> Answer<()> {
    let _one = shell
        .files
        .lock()
        .map_err(|_| ShellError::new("IO", "the app's files are locked"))?;
    let all = store::remove(&repos(&shell)?, &path);
    store::write_file(&shell.machine.repos_file(), &store::write_repos(&all))
}

#[derive(Serialize)]
struct Url {
    url: String,
}

/// The repository's daemon, started when none runs (`serve --ensure`, ADR-0101). A dev
/// container's (its key, ADR-0106): the daemon in the container, reached through this computer's
/// loopback forwarder, whose address is answered.
#[tauri::command(async)]
fn open_repo(shell: State<'_, Shell>, path: String) -> Answer<Url> {
    if let Some(local_folder) = devcontainer::local_folder_of(&path) {
        return open_container(&shell, &path, local_folder);
    }
    let data = shell.machine.run(&daemon::ensure_args(&path))?;
    Ok(Url {
        url: daemon::url(&data)?,
    })
}

/// The same as `open_repo`, by its earlier name (ADR-0101): the address alone.
#[tauri::command(async)]
fn ensure_daemon(shell: State<'_, Shell>, folder: String) -> Answer<String> {
    if let Some(local_folder) = devcontainer::local_folder_of(&folder) {
        return open_container(&shell, &folder, local_folder).map(|u| u.url);
    }
    daemon::url(&shell.machine.run(&daemon::ensure_args(&folder))?)
}

/// The daemon in a dev container (installed and started when needed) and the window's way to it.
fn open_container(shell: &Shell, key: &str, local_folder: &str) -> Answer<Url> {
    let workspace = repos(shell)?
        .into_iter()
        .find(|r| r.path == key)
        .and_then(|r| r.devcontainer)
        .map(|d| d.workspace_folder);
    let data = shell.machine.run(&devcontainer::serve_args(
        local_folder,
        workspace.as_deref(),
        bundles(shell).as_deref(),
    ))?;
    let argv = devcontainer::tunnel_of(&data)?;
    let mut all = shell
        .forwarders
        .lock()
        .map_err(|_| ShellError::new("IO", "the forwarders are locked"))?;
    let port = match all.get(key) {
        Some(f) => {
            f.point(argv);
            f.port()
        }
        None => {
            let f = forward::Forwarder::start(argv, forward::processes()).map_err(|e| {
                ShellError::new("IO", &format!("cannot listen on this computer: {e}"))
            })?;
            let port = f.port();
            all.insert(key.to_string(), f);
            port
        }
    };
    Ok(Url {
        url: devcontainer::local_url(port),
    })
}

/// The dev containers docker (or nerdctl) knows; `engine: null` with the problem when none answers.
#[tauri::command(async)]
fn list_devcontainers(shell: State<'_, Shell>) -> Answer<Value> {
    shell.machine.run(&devcontainer::list_args())
}

/// Starts a stopped dev container; answers it running.
#[tauri::command(async)]
fn start_devcontainer(shell: State<'_, Shell>, local_folder: String) -> Answer<Value> {
    shell.machine.run(&devcontainer::start_args(&local_folder))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallDone {
    run_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    /// The launcher inside the container.
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ShellError>,
}

/// Copies the Linux CLI into the dev container unless its version is there; answers at once. Its
/// lines come as `container://install-output`, its end as `container://install-done`.
#[tauri::command(async)]
fn install_in_container(
    app: AppHandle,
    shell: State<'_, Shell>,
    local_folder: String,
) -> Answer<RunId> {
    let run_id = run_id(&shell, "install");
    let args = devcontainer::install_args(&local_folder, bundles(&shell).as_deref());
    let (id, handle) = (run_id.clone(), app.clone());
    std::thread::spawn(move || {
        let (out_app, out_id) = (handle.clone(), id.clone());
        let shell = handle.state::<Shell>();
        let done = match shell.machine.stream(&args, move |l| {
            let _ = out_app.emit(
                "container://install-output",
                SetupOutput {
                    run_id: out_id.clone(),
                    line: l.to_string(),
                },
            );
        }) {
            Ok((data, _)) => InstallDone {
                run_id: id.clone(),
                ok: true,
                version: envelope::text(&data, "version"),
                path: envelope::text(&data, "path"),
                error: None,
            },
            Err(e) => InstallDone {
                run_id: id.clone(),
                ok: false,
                version: None,
                path: None,
                error: Some(e),
            },
        };
        let _ = handle.emit("container://install-done", done);
    });
    Ok(RunId { run_id })
}

/// Opens VS Code's link on this computer (a dev container's editor link); any other link is refused.
#[tauri::command(async)]
#[allow(deprecated)]
fn open_uri(app: AppHandle, uri: String) -> Answer<()> {
    use tauri_plugin_shell::ShellExt;
    devcontainer::check_uri(&uri)?;
    app.shell()
        .open(uri.trim(), None)
        .map_err(|e| ShellError::new("SPAWN", &format!("cannot open {uri}: {e}")))
}

#[derive(Serialize)]
struct CliInfo {
    source: Source,
    path: String,
    version: String,
}

fn info(shell: &Shell) -> Answer<CliInfo> {
    let resolved = shell.machine.resolve()?;
    let version = shell
        .machine
        .run_with(&resolved, &strings(&["version", "--json"]))
        .ok()
        .and_then(|d| envelope::text(&d, "version"))
        .unwrap_or_default();
    Ok(CliInfo {
        source: resolved.source,
        path: resolved.program.to_string_lossy().to_string(),
        version,
    })
}

#[tauri::command(async)]
fn cli_info(shell: State<'_, Shell>) -> Answer<CliInfo> {
    info(&shell)
}

/// The person's choice of `metator`: the bundled one, the one on PATH, or a program they name.
#[tauri::command(async)]
fn set_cli_source(
    shell: State<'_, Shell>,
    source: Source,
    path: Option<String>,
) -> Answer<CliInfo> {
    if source == Source::Custom {
        cli::check_custom(path.as_deref().unwrap_or(""), |p| p.is_file())?;
    }
    let choice = Choice {
        source,
        path: if source == Source::Custom {
            path.map(|p| p.trim().to_string())
        } else {
            None
        },
    };
    {
        let _one = shell
            .files
            .lock()
            .map_err(|_| ShellError::new("IO", "the app's files are locked"))?;
        store::write_file(
            &shell.machine.settings_file(),
            &store::write_settings(&choice),
        )?;
    }
    info(&shell)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Installed {
    path: String,
    on_path: bool,
}

fn launcher_target(app: &AppHandle) -> Answer<PathBuf> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| ShellError::new("IO", &format!("no home folder: {e}")))?;
    let local = std::env::var("LOCALAPPDATA").ok().map(PathBuf::from);
    Ok(launcher::target(&home, local.as_deref(), WINDOWS))
}

/// Windows: the user PATH, read and written through PowerShell (new terminals see it).
fn user_path(change: impl Fn(&str) -> Option<String>) -> Answer<()> {
    let ps = |script: &str, value: Option<&str>| {
        let mut c = std::process::Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        if let Some(v) = value {
            c.env("METATOR_USER_PATH", v);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        c.output()
            .map_err(|e| ShellError::new("SPAWN", &format!("cannot run powershell: {e}")))
    };
    let read = ps("[Environment]::GetEnvironmentVariable('Path','User')", None)?;
    let now = String::from_utf8_lossy(&read.stdout).trim().to_string();
    if let Some(next) = change(&now) {
        let set = ps(
            "[Environment]::SetEnvironmentVariable('Path', $env:METATOR_USER_PATH, 'User')",
            Some(&next),
        )?;
        if !set.status.success() {
            return Err(ShellError::new("IO", "the user PATH could not be changed"));
        }
    }
    Ok(())
}

/// Writes the `metator` launcher into a user folder on the PATH (only on the person's click).
#[tauri::command(async)]
fn install_cli_command(app: AppHandle, shell: State<'_, Shell>) -> Answer<Installed> {
    launcher::refuse_appimage(std::env::var("APPIMAGE").ok().as_deref())?;
    let sidecar = paths::sidecar(&shell.machine.exe_dir, WINDOWS);
    if !sidecar.is_file() {
        return Err(
            ShellError::new("NO_CLI", "this build of the app has no bundled metator").hint(
                "A developer's build runs the metator on the PATH: there is nothing to install.",
            ),
        );
    }
    let resources = shell.machine.resources().ok_or_else(|| {
        ShellError::new("NOT_FOUND", "the app's metator-resources folder is missing")
            .hint("Reinstall the app.")
    })?;
    let target = launcher_target(&app)?;
    let script = if WINDOWS {
        launcher::windows_script(&sidecar, &resources)
    } else {
        launcher::unix_script(&sidecar, &resources)
    };
    launcher::install(&target, &script)?;
    let dir = target.parent().map(Path::to_path_buf).unwrap_or_default();
    let on_path = if WINDOWS {
        user_path(|now| launcher::user_path_with(now, &dir))?;
        true
    } else {
        launcher::on_path(&dir, &shell.machine.path(None), false)
    };
    Ok(Installed {
        path: target.to_string_lossy().to_string(),
        on_path,
    })
}

#[derive(Serialize)]
struct Removed {
    path: Option<String>,
}

/// Removes the launcher the app wrote; never a `metator` it did not write.
#[tauri::command(async)]
fn uninstall_cli_command(app: AppHandle) -> Answer<Removed> {
    let target = launcher_target(&app)?;
    let removed = launcher::uninstall(&target)?;
    if WINDOWS && removed {
        let dir = target.parent().map(Path::to_path_buf).unwrap_or_default();
        user_path(|now| launcher::user_path_without(now, &dir))?;
    }
    Ok(Removed {
        path: removed.then(|| target.to_string_lossy().to_string()),
    })
}

/// The Linux CLI bundle for a Dev Container of this architecture (x64, arm64; Docker's and
/// `uname -m`'s names too): its tarball, version and launcher. Windows and macOS builds carry it.
#[tauri::command(async)]
fn linux_cli_bundle(shell: State<'_, Shell>, arch: String) -> Answer<bundle::Bundle> {
    bundle::find(
        shell.machine.resource_dir.as_deref(),
        &arch,
        |p| std::fs::read_to_string(p).ok(),
        |p| p.is_file(),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|e| e.parent().map(Path::to_path_buf))
                .unwrap_or_default();
            let resource_dir = app.path().resource_dir().ok();
            let data_dir = app.path().app_data_dir()?;
            app.manage(Shell {
                machine: Machine::new(exe_dir, resource_dir, data_dir),
                files: Mutex::new(()),
                runs: AtomicU64::new(0),
                forwarders: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            inspect_folder,
            run_setup,
            git_init,
            commit_setup,
            known_repos,
            add_repo,
            remove_repo,
            open_repo,
            ensure_daemon,
            cli_info,
            set_cli_source,
            install_cli_command,
            uninstall_cli_command,
            linux_cli_bundle,
            list_devcontainers,
            start_devcontainer,
            install_in_container,
            open_uri
        ])
        .run(tauri::generate_context!())
        .expect("error while running the MetatorAI desktop app");
}
