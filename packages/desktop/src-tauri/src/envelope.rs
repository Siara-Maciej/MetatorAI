//! What the CLI answers (its one JSON line, `{ok, data}` or `{ok: false, error}`) and what the
//! window gets back: the data, or an error `{code, message, hint}` (ADR-0105).

use serde::Serialize;
use serde_json::Value;

/// Every error a command of the shell rejects with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShellError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl ShellError {
    pub fn new(code: &str, message: &str) -> Self {
        ShellError {
            code: code.to_string(),
            message: message.to_string(),
            hint: None,
        }
    }

    pub fn hint(mut self, hint: &str) -> Self {
        self.hint = Some(hint.to_string());
        self
    }
}

impl std::fmt::Display for ShellError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// The data of the CLI's envelope: the last line of stdout that is JSON (a profile may print before
/// it); without one, the last lines the program said, as the error.
pub fn data(stdout: &str, stderr: &str) -> Result<Value, ShellError> {
    let envelope = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('{'))
        .and_then(|l| serde_json::from_str::<Value>(l).ok());
    if let Some(env) = envelope {
        if env.get("ok") == Some(&Value::Bool(true)) {
            return Ok(env.get("data").cloned().unwrap_or(Value::Null));
        }
        if let Some(e) = env.get("error") {
            let text = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_string);
            return Err(ShellError {
                code: text("code").unwrap_or_else(|| "COMMAND_FAILED".to_string()),
                message: text("message").unwrap_or_else(|| "metator failed".to_string()),
                hint: text("hint"),
            });
        }
    }
    let said = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if said.is_empty() {
        return Err(ShellError::new("COMMAND_FAILED", "metator printed nothing"));
    }
    let lines: Vec<&str> = said.lines().collect();
    let tail = lines[lines.len().saturating_sub(5)..].join("\n");
    Err(ShellError::new("COMMAND_FAILED", &tail))
}

/// A string field of the data.
pub fn text(data: &Value, field: &str) -> Option<String> {
    data.get(field).and_then(Value::as_str).map(str::to_string)
}

/// What `setup` wrote (its report's `written`), sorted.
pub fn written(data: &Value) -> Vec<String> {
    let mut files: Vec<String> = data
        .get("written")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

/// The lines the setup screen shows after the run: what it wrote, each check, and the warnings.
pub fn setup_summary(data: &Value, warnings: &[String]) -> Vec<String> {
    let mut lines = vec![format!("Setup wrote {} files.", written(data).len())];
    if let Some(checks) = data.get("checks").and_then(Value::as_array) {
        for c in checks {
            let passed = c.get("passed").and_then(Value::as_bool).unwrap_or(false);
            let command = c.get("command").and_then(Value::as_str).unwrap_or("?");
            lines.push(format!(
                "{} metator {command}",
                if passed { "✓" } else { "✗" }
            ));
        }
    }
    lines.extend(warnings.iter().map(|w| format!("warning: {w}")));
    lines
}

/// The envelope's warnings (beside its data).
pub fn warnings(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('{'))
        .and_then(|l| serde_json::from_str::<Value>(l).ok())
        .and_then(|v| v.get("warnings").cloned())
        .and_then(|w| w.as_array().cloned())
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_data_is_read_from_the_last_json_line_after_any_profile_noise() {
        let out = "Welcome back\n{\"ok\":true,\"data\":{\"url\":\"http://127.0.0.1:4711\"}}\n";
        assert_eq!(
            text(&data(out, "").unwrap(), "url"),
            Some("http://127.0.0.1:4711".to_string())
        );
    }

    #[test]
    fn an_error_envelope_keeps_its_code_message_and_hint() {
        let out = r#"{"ok":false,"error":{"code":"USAGE","message":"no repository at \"/x\"","hint":"Run it in one."}}"#;
        let e = data(out, "").unwrap_err();
        assert_eq!(
            e,
            ShellError::new("USAGE", "no repository at \"/x\"").hint("Run it in one.")
        );
        assert_eq!(
            serde_json::to_value(ShellError::new("IO", "x")).unwrap(),
            json!({"code": "IO", "message": "x"})
        );
    }

    #[test]
    fn no_envelope_gives_the_last_lines_said() {
        assert_eq!(
            data("", "sh: metator: command not found\n")
                .unwrap_err()
                .message,
            "sh: metator: command not found"
        );
        assert_eq!(data("", "").unwrap_err().message, "metator printed nothing");
        let many = (1..=8)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            data("", &many).unwrap_err().message,
            "line 4\nline 5\nline 6\nline 7\nline 8"
        );
    }

    #[test]
    fn setup_says_what_it_wrote_each_check_and_the_warnings() {
        let report = json!({
            "written": ["b.md", "a.md"],
            "checks": [{"command": "meta agents-lint", "passed": true}, {"command": "generate --check", "passed": false}]
        });
        assert_eq!(written(&report), ["a.md", "b.md"]);
        assert_eq!(
            setup_summary(&report, &["no test script".to_string()]),
            [
                "Setup wrote 2 files.",
                "✓ metator meta agents-lint",
                "✗ metator generate --check",
                "warning: no test script"
            ]
        );
        assert_eq!(written(&json!({})), Vec::<String>::new());
        assert_eq!(
            warnings(r#"{"ok":true,"data":{},"warnings":["w1"]}"#),
            ["w1"]
        );
        assert_eq!(warnings("nothing"), Vec::<String>::new());
    }
}
