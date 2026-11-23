//! Where the programs are (ADR-0105): the bundled `metator` beside the app's executable, its
//! resources folder, and the PATH every process the app starts gets. Pure functions over paths and
//! strings; the shell's commands call them with what the machine says.

use std::path::{Path, PathBuf};

/// The resources folder's name inside the app's resource directory (the compile script makes it).
pub const RESOURCES_DIR: &str = "metator-resources";

/// The bundled CLI: Tauri puts a sidecar beside the app's own executable, without the target suffix.
pub fn sidecar(exe_dir: &Path, windows: bool) -> PathBuf {
    exe_dir.join(if windows { "metator.exe" } else { "metator" })
}

/// The separator of PATH's entries.
pub fn separator(windows: bool) -> char {
    if windows {
        ';'
    } else {
        ':'
    }
}

/// The PATH of every process the app starts: the CLI's folder first (a hook's plain `metator` is the
/// one the app runs), then the login shell's PATH (an app opened from its icon lacks the terminal's,
/// where `git`, `claude` and `copilot` usually are), then the app's own; each folder once.
pub fn compose_path(
    cli_dir: Option<&Path>,
    login: Option<&str>,
    current: &str,
    windows: bool,
) -> String {
    let sep = separator(windows);
    let mut out: Vec<String> = Vec::new();
    let mut push = |entry: &str| {
        let entry = entry.trim();
        if !entry.is_empty() && !out.iter().any(|e| e == entry) {
            out.push(entry.to_string());
        }
    };
    if let Some(dir) = cli_dir {
        push(&dir.to_string_lossy());
    }
    for part in login.unwrap_or("").split(sep) {
        push(part);
    }
    for part in current.split(sep) {
        push(part);
    }
    out.join(&sep.to_string())
}

/// The marker the login shell prints its PATH after: what a profile prints itself comes before it.
pub const PATH_MARKER: &str = "__METATOR_PATH__=";

/// The script the login shell runs to say its PATH.
pub fn login_path_script() -> String {
    format!("printf '\\n{PATH_MARKER}%s\\n' \"$PATH\"")
}

/// The PATH a login shell printed after the marker; none when it printed no marker.
pub fn parse_login_path(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix(PATH_MARKER))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

/// A program found on `path`: on Windows with the extensions of PATHEXT (`metator.cmd` is npm's shim).
pub fn find_on_path(
    program: &str,
    path: &str,
    windows: bool,
    pathext: &str,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let names: Vec<String> = if windows {
        let mut n: Vec<String> = pathext
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| format!("{program}{}", e.to_lowercase()))
            .collect();
        if n.is_empty() {
            n = vec![format!("{program}.exe"), format!("{program}.cmd")];
        }
        n
    } else {
        vec![program.to_string()]
    };
    for dir in path
        .split(separator(windows))
        .filter(|d| !d.trim().is_empty())
    {
        for name in &names {
            let candidate = Path::new(dir).join(name);
            if exists(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// How a program is started: a `.cmd` or `.bat` through `cmd /C` (Windows cannot start them directly).
pub fn invocation(program: &Path, args: &[String]) -> (String, Vec<String>) {
    let p = program.to_string_lossy().to_string();
    let ext = program
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext == "cmd" || ext == "bat" {
        let mut all = vec!["/C".to_string(), p];
        all.extend(args.iter().cloned());
        return ("cmd".to_string(), all);
    }
    (p, args.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sidecar_is_beside_the_executable() {
        assert_eq!(
            sidecar(Path::new("/usr/bin"), false),
            PathBuf::from("/usr/bin/metator")
        );
        assert_eq!(
            sidecar(Path::new("C:\\Program Files\\MetatorAI"), true),
            Path::new("C:\\Program Files\\MetatorAI").join("metator.exe")
        );
    }

    #[test]
    fn path_is_the_cli_first_then_the_login_shell_then_the_apps_own_each_once() {
        let path = compose_path(
            Some(Path::new("/Applications/MetatorAI.app/Contents/MacOS")),
            Some("/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin"),
            "/usr/bin:/bin:/usr/sbin",
            false,
        );
        assert_eq!(
            path,
            "/Applications/MetatorAI.app/Contents/MacOS:/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin:/bin:/usr/sbin"
        );
        assert_eq!(
            compose_path(None, None, "/usr/bin::/bin", false),
            "/usr/bin:/bin"
        );
        assert_eq!(
            compose_path(
                Some(Path::new("C:\\App")),
                None,
                "C:\\Windows;C:\\App",
                true
            ),
            "C:\\App;C:\\Windows"
        );
    }

    #[test]
    fn the_login_path_is_read_after_the_marker_whatever_a_profile_printed() {
        let out =
            format!("Welcome!\nnvm: using node 22\n\n{PATH_MARKER}/home/me/.nvm/bin:/usr/bin\n");
        assert_eq!(
            parse_login_path(&out),
            Some("/home/me/.nvm/bin:/usr/bin".to_string())
        );
        assert_eq!(parse_login_path("no marker here"), None);
        assert_eq!(parse_login_path(&format!("{PATH_MARKER}\n")), None);
        assert!(login_path_script().contains(PATH_MARKER));
    }

    #[cfg(unix)]
    #[test]
    fn the_real_shell_prints_its_path_after_the_marker() {
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &login_path_script()])
            .env("PATH", "/x/bin:/usr/bin:/bin")
            .output()
            .unwrap();
        assert_eq!(
            parse_login_path(&String::from_utf8_lossy(&out.stdout)),
            Some("/x/bin:/usr/bin:/bin".to_string())
        );
    }

    #[test]
    fn a_program_is_found_on_path_with_windows_extensions() {
        let there = |p: &Path| p == Path::new("/b/metator");
        assert_eq!(
            find_on_path("metator", "/a:/b:/c", false, "", there),
            Some(PathBuf::from("/b/metator"))
        );
        assert_eq!(find_on_path("metator", "/a:/c", false, "", there), None);
        let npm = Path::new("C:\\npm").join("metator.cmd");
        let win = |p: &Path| p == npm.as_path();
        assert_eq!(
            find_on_path("metator", "C:\\bin;C:\\npm", true, ".COM;.EXE;.CMD", win),
            Some(npm.clone())
        );
        assert_eq!(find_on_path("metator", "C:\\npm", true, "", win), Some(npm));
    }

    #[test]
    fn a_cmd_shim_starts_through_cmd() {
        let (program, args) =
            invocation(Path::new("C:\\npm\\metator.cmd"), &["version".to_string()]);
        assert_eq!(program, "cmd");
        assert_eq!(args, ["/C", "C:\\npm\\metator.cmd", "version"]);
        let (program, args) = invocation(Path::new("/usr/bin/metator"), &["version".to_string()]);
        assert_eq!(
            (program.as_str(), args),
            ("/usr/bin/metator", vec!["version".to_string()])
        );
    }
}
