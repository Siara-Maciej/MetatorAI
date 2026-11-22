//! The one thing the shell does besides showing the window (ADR-0087): it asks the `metator`
//! program for the daemon of a folder. `metator serve --ensure` finds the daemon that serves the
//! folder or starts one in the background, and prints its address; nothing about runs lives here.

use std::process::Command;

const ENSURE: [&str; 4] = ["serve", "--ensure", "--port", "0"];

/// The program and its arguments. `bin` is `$METATOR_BIN` (a path to the program) and wins. Else
/// on Unix the person's login shell runs `metator`, because an app opened from its icon does not
/// get the terminal's `PATH`; on Windows `cmd` does, because `metator` is a `.cmd` shim there.
pub fn command(
    folder: &str,
    bin: Option<&str>,
    login_shell: Option<&str>,
    windows: bool,
) -> (String, Vec<String>) {
    let ensure = ENSURE.iter().map(|s| s.to_string());
    if let Some(bin) = bin.filter(|b| !b.trim().is_empty()) {
        let mut args = vec!["-C".to_string(), folder.to_string()];
        args.extend(ensure);
        return (bin.to_string(), args);
    }
    if windows {
        let mut args = vec![
            "/C".to_string(),
            "metator".to_string(),
            "-C".to_string(),
            folder.to_string(),
        ];
        args.extend(ensure);
        return ("cmd".to_string(), args);
    }
    // `$0` is the folder: it reaches the program as one argument, whatever characters it holds.
    let script = format!("exec metator -C \"$0\" {}", ENSURE.join(" "));
    (
        login_shell
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("/bin/sh")
            .to_string(),
        vec!["-lc".to_string(), script, folder.to_string()],
    )
}

/// The text of a JSON string field, as the CLI's one-line envelope writes it.
fn field(json: &str, name: &str) -> Option<String> {
    let key = format!("\"{name}\":\"");
    let start = json.find(&key)? + key.len();
    let mut out = String::new();
    let mut chars = json[start..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                other => out.push(other),
            },
            other => out.push(other),
        }
    }
    None
}

/// The daemon's address from what the command printed, or why there is none.
pub fn address(stdout: &str, stderr: &str) -> Result<String, String> {
    // A login shell may print its own lines first: the envelope is the last line that is JSON.
    let envelope = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or("");
    if envelope.contains("\"ok\":true") {
        if let Some(url) = field(envelope, "url") {
            return Ok(url);
        }
    }
    if let Some(message) = field(envelope, "message") {
        return Err(message);
    }
    let said = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    Err(if said.is_empty() {
        "metator printed nothing".to_string()
    } else {
        said.lines()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
    })
}

/// The address of the daemon that serves `folder`, started when none runs.
pub fn ensure(folder: &str) -> Result<String, String> {
    let bin = std::env::var("METATOR_BIN").ok();
    let shell = std::env::var("SHELL").ok();
    let (program, args) = command(folder, bin.as_deref(), shell.as_deref(), cfg!(windows));
    let output = Command::new(&program).args(&args).output().map_err(|e| {
        format!("cannot run {program}: {e}. Install MetatorAI so that `metator` is on your PATH, or set METATOR_BIN to the program.")
    })?;
    address(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metator_bin_wins_and_gets_the_folder_as_one_argument() {
        let (program, args) = command(
            "/work/my shop",
            Some("/opt/metator"),
            Some("/bin/zsh"),
            false,
        );
        assert_eq!(program, "/opt/metator");
        assert_eq!(
            args,
            ["-C", "/work/my shop", "serve", "--ensure", "--port", "0"]
        );
    }

    #[test]
    fn unix_runs_metator_through_the_login_shell_with_the_folder_as_dollar_zero() {
        let (program, args) = command("/work/my shop", None, Some("/bin/zsh"), false);
        assert_eq!(program, "/bin/zsh");
        assert_eq!(
            args,
            [
                "-lc",
                "exec metator -C \"$0\" serve --ensure --port 0",
                "/work/my shop"
            ]
        );
        assert_eq!(command("/w", Some(" "), None, false).0, "/bin/sh");
    }

    #[test]
    fn windows_runs_the_cmd_shim() {
        let (program, args) = command("C:\\work", None, None, true);
        assert_eq!(program, "cmd");
        assert_eq!(args[..4], ["/C", "metator", "-C", "C:\\work"]);
    }

    #[test]
    fn the_address_is_read_from_the_envelope_after_any_shell_noise() {
        let out = "Welcome back\n{\"ok\":true,\"data\":{\"url\":\"http://127.0.0.1:4711\",\"pid\":9,\"started\":true}}\n";
        assert_eq!(address(out, ""), Ok("http://127.0.0.1:4711".to_string()));
    }

    #[test]
    fn an_error_envelope_gives_its_message_and_no_envelope_the_last_lines() {
        let out = "{\"ok\":false,\"error\":{\"code\":\"USAGE\",\"message\":\"no repository at \\\"/x\\\"\"}}";
        assert_eq!(address(out, ""), Err("no repository at \"/x\"".to_string()));
        assert_eq!(
            address("", "sh: metator: command not found\n"),
            Err("sh: metator: command not found".to_string())
        );
        assert_eq!(address("", ""), Err("metator printed nothing".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn the_real_shell_passes_a_folder_with_spaces_and_quotes_whole() {
        // The same script shape, with `printf` standing in for metator.
        let out = Command::new("/bin/sh")
            .args(["-c", "exec printf '%s' \"$0\"", "/work/it's \"mine\""])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "/work/it's \"mine\"");
    }
}
