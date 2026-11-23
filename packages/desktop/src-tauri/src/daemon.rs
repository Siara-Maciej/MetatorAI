//! The daemon of a folder (ADR-0101): the shell asks the `metator` program for it.
//! `metator serve --ensure` finds the daemon that serves the folder or starts one in the
//! background, and prints its address; nothing about runs lives here.

use crate::envelope::{text, ShellError};
use serde_json::Value;

/// The arguments that ask for the folder's daemon; the folder reaches the program as one argument.
pub fn ensure_args(folder: &str) -> Vec<String> {
    ["-C", folder, "serve", "--ensure", "--port", "0"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// The daemon's address from the data `serve --ensure` answered.
pub fn url(data: &Value) -> Result<String, ShellError> {
    text(data, "url").ok_or_else(|| {
        ShellError::new(
            "COMMAND_FAILED",
            "metator serve --ensure answered no address",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::data;

    #[test]
    fn the_folder_is_one_argument_whatever_it_holds() {
        assert_eq!(
            ensure_args("/work/it's \"mine\""),
            [
                "-C",
                "/work/it's \"mine\"",
                "serve",
                "--ensure",
                "--port",
                "0"
            ]
        );
    }

    #[test]
    fn the_address_is_read_from_the_envelope_after_any_noise() {
        let out = "Welcome back\n{\"ok\":true,\"data\":{\"url\":\"http://127.0.0.1:4711\",\"pid\":9,\"started\":true}}\n";
        assert_eq!(
            url(&data(out, "").unwrap()),
            Ok("http://127.0.0.1:4711".to_string())
        );
        assert_eq!(
            url(&serde_json::json!({"pid": 9})).unwrap_err().code,
            "COMMAND_FAILED"
        );
    }
}
