//! "Install the metator command" (ADR-0105), like VS Code's "Install 'code' command in PATH": a
//! small launcher that runs the app's bundled CLI, written only when the person clicks, into a
//! user folder on the PATH (`~/.local/bin` on Linux and macOS; on Windows a per-user folder added
//! to the user PATH). It names itself, so the app removes only a launcher it wrote.

use crate::envelope::ShellError;
use std::path::{Path, PathBuf};

/// The line every launcher the app writes carries; a file without it is never overwritten or removed.
pub const MARKER: &str = "Written by the MetatorAI app (Settings: Install the metator command)";

/// Where the launcher goes: `~/.local/bin/metator`, or `%LOCALAPPDATA%\MetatorAI\bin\metator.cmd`.
pub fn target(home: &Path, local_app_data: Option<&Path>, windows: bool) -> PathBuf {
    if windows {
        let base = local_app_data
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        return base.join("MetatorAI").join("bin").join("metator.cmd");
    }
    home.join(".local").join("bin").join("metator")
}

/// A shell word: single quotes, with a quote inside written as '\''.
fn quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The launcher on Linux and macOS: the bundled CLI with its resources named.
pub fn unix_script(sidecar: &Path, resources: &Path) -> String {
    format!(
        "#!/bin/sh\n# {MARKER}\nMETATOR_RESOURCES={} exec {} \"$@\"\n",
        quoted(&resources.to_string_lossy()),
        quoted(&sidecar.to_string_lossy())
    )
}

/// The launcher on Windows: a .cmd that passes its arguments on.
pub fn windows_script(sidecar: &Path, resources: &Path) -> String {
    format!(
        "@echo off\r\nrem {MARKER}\r\nset \"METATOR_RESOURCES={}\"\r\n\"{}\" %*\r\n",
        resources.display(),
        sidecar.display()
    )
}

fn ours(text: &str) -> bool {
    text.contains(MARKER)
}

/// Writes the launcher; a file there that the app did not write (the person's own `metator`) stays.
pub fn install(target: &Path, script: &str) -> Result<(), ShellError> {
    let io = |e: std::io::Error| {
        ShellError::new("IO", &format!("cannot write {}: {e}", target.display()))
    };
    if let Ok(text) = std::fs::read_to_string(target) {
        if !ours(&text) {
            return Err(ShellError::new("EXISTS", &format!("{} is already there and the app did not write it", target.display()))
                .hint("It is another metator (npm's, or one you made): remove it yourself if the app's should take its place."));
        }
    } else if target.exists() {
        return Err(ShellError::new(
            "EXISTS",
            &format!(
                "{} is already there and the app did not write it",
                target.display()
            ),
        ));
    }
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    std::fs::write(target, script).map_err(io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755)).map_err(io)?;
    }
    Ok(())
}

/// Removes the launcher the app wrote: true when there was one, false when there was none.
pub fn uninstall(target: &Path) -> Result<bool, ShellError> {
    let text = match std::fs::read_to_string(target) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(ShellError::new(
                "IO",
                &format!("cannot read {}: {e}", target.display()),
            ))
        }
    };
    if !ours(&text) {
        return Err(ShellError::new(
            "EXISTS",
            &format!("{} was not written by the app: it stays", target.display()),
        ));
    }
    std::fs::remove_file(target)
        .map(|_| true)
        .map_err(|e| ShellError::new("IO", &format!("cannot remove {}: {e}", target.display())))
}

/// Whether a folder is on a PATH.
pub fn on_path(dir: &Path, path: &str, windows: bool) -> bool {
    let sep = if windows { ';' } else { ':' };
    let want = dir.to_string_lossy();
    let norm = |s: &str| {
        let t = s.trim().trim_end_matches(['/', '\\']).to_string();
        if windows {
            t.to_lowercase()
        } else {
            t
        }
    };
    path.split(sep).any(|p| norm(p) == norm(&want))
}

/// The user PATH with the folder added at the end; none when it is there already.
pub fn user_path_with(user_path: &str, dir: &Path) -> Option<String> {
    if on_path(dir, user_path, true) {
        return None;
    }
    let trimmed = user_path.trim_end_matches(';');
    Some(if trimmed.is_empty() {
        dir.display().to_string()
    } else {
        format!("{trimmed};{}", dir.display())
    })
}

/// The user PATH without the folder; none when it was not there.
pub fn user_path_without(user_path: &str, dir: &Path) -> Option<String> {
    if !on_path(dir, user_path, true) {
        return None;
    }
    let want = dir
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_lowercase();
    Some(
        user_path
            .split(';')
            .filter(|p| {
                !p.trim().is_empty()
                    && p.trim().trim_end_matches(['/', '\\']).to_lowercase() != want
            })
            .collect::<Vec<_>>()
            .join(";"),
    )
}

/// An AppImage's files are in a folder mounted while it runs: a launcher pointing there breaks.
pub fn refuse_appimage(appimage: Option<&str>) -> Result<(), ShellError> {
    match appimage.filter(|a| !a.is_empty()) {
        Some(_) => Err(ShellError::new(
            "UNSUPPORTED",
            "the AppImage cannot install the metator command: its files move each time it starts",
        )
        .hint("Install the .deb package for the metator command, or install metator from npm.")),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("metator-launcher-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn the_launcher_goes_to_a_user_bin_folder() {
        assert_eq!(
            target(Path::new("/home/me"), None, false),
            PathBuf::from("/home/me/.local/bin/metator")
        );
        assert_eq!(
            target(
                Path::new("C:\\Users\\me"),
                Some(Path::new("C:\\Users\\me\\AppData\\Local")),
                true
            ),
            Path::new("C:\\Users\\me\\AppData\\Local")
                .join("MetatorAI")
                .join("bin")
                .join("metator.cmd")
        );
    }

    #[test]
    fn the_scripts_run_the_bundled_cli_with_its_resources_and_pass_every_argument() {
        let s = unix_script(
            Path::new("/opt/Metator AI/metator"),
            Path::new("/usr/lib/MetatorAI/metator-resources"),
        );
        assert_eq!(
            s,
            format!("#!/bin/sh\n# {MARKER}\nMETATOR_RESOURCES='/usr/lib/MetatorAI/metator-resources' exec '/opt/Metator AI/metator' \"$@\"\n")
        );
        assert_eq!(quoted("it's"), "'it'\\''s'");
        let w = windows_script(
            Path::new("C:\\Program Files\\MetatorAI\\metator.exe"),
            Path::new("C:\\Program Files\\MetatorAI\\metator-resources"),
        );
        assert!(w.contains(
            "set \"METATOR_RESOURCES=C:\\Program Files\\MetatorAI\\metator-resources\"\r\n"
        ));
        assert!(w.contains("\"C:\\Program Files\\MetatorAI\\metator.exe\" %*\r\n"));
        assert!(w.contains(MARKER));
    }

    #[cfg(unix)]
    #[test]
    fn the_written_launcher_runs_and_passes_arguments_whole() {
        let dir = temp("run");
        let fake = dir.join("fake cli");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &fake,
            "#!/bin/sh\nprintf '%s|' \"$METATOR_RESOURCES\" \"$@\"\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let launcher = dir.join("bin").join("metator");
        install(&launcher, &unix_script(&fake, Path::new("/res"))).unwrap();
        let out = std::process::Command::new(&launcher)
            .args(["setup", "a b"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "/res|setup|a b|");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_a_launcher_the_app_wrote_is_replaced_or_removed() {
        let dir = temp("own");
        let launcher = dir.join("metator");
        assert!(!uninstall(&launcher).unwrap());
        install(&launcher, &format!("# {MARKER}\nold\n")).unwrap();
        install(&launcher, &format!("# {MARKER}\nnew\n")).unwrap();
        assert!(std::fs::read_to_string(&launcher).unwrap().contains("new"));
        assert!(uninstall(&launcher).unwrap());
        assert!(!launcher.exists());
        std::fs::write(&launcher, "#!/bin/sh\nexec bun ~/metator/main.ts \"$@\"\n").unwrap();
        assert_eq!(install(&launcher, "x").unwrap_err().code, "EXISTS");
        assert_eq!(uninstall(&launcher).unwrap_err().code, "EXISTS");
        assert!(launcher.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_folder_on_path_and_the_windows_user_path() {
        assert!(on_path(
            Path::new("/home/me/.local/bin"),
            "/usr/bin:/home/me/.local/bin/",
            false
        ));
        assert!(!on_path(
            Path::new("/home/me/.local/bin"),
            "/usr/bin",
            false
        ));
        let dir = Path::new("C:\\Users\\me\\AppData\\Local\\MetatorAI\\bin");
        assert!(on_path(
            dir,
            "C:\\Windows;c:\\users\\me\\appdata\\local\\metatorai\\bin",
            true
        ));
        assert_eq!(
            user_path_with("C:\\tools;", dir),
            Some(format!("C:\\tools;{}", dir.display()))
        );
        assert_eq!(user_path_with("", dir), Some(dir.display().to_string()));
        assert_eq!(
            user_path_with(&format!("C:\\tools;{}", dir.display()), dir),
            None
        );
        assert_eq!(
            user_path_without(&format!("C:\\tools;{};C:\\x", dir.display()), dir),
            Some("C:\\tools;C:\\x".to_string())
        );
        assert_eq!(user_path_without("C:\\tools", dir), None);
    }

    #[test]
    fn an_appimage_cannot_install_it() {
        assert_eq!(
            refuse_appimage(Some("/home/me/MetatorAI.AppImage"))
                .unwrap_err()
                .code,
            "UNSUPPORTED"
        );
        assert!(refuse_appimage(None).is_ok());
        assert!(refuse_appimage(Some("")).is_ok());
    }
}
