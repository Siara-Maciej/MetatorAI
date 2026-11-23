//! Dev Containers (ADR-0106): the shell runs the app's own `metator devcontainer …` on this
//! computer, which reaches the person's containers through docker or nerdctl. Here: the command
//! lines it runs, the key a dev container's repository has in the app's list, and which links
//! `open_uri` opens. Pure functions; `forward` holds the loopback forwarder.

use crate::envelope::ShellError;
use serde_json::Value;
use std::path::Path;

/// The key of a dev container's repository in `repos.json`: never a folder on this computer.
pub const KEY_PREFIX: &str = "devcontainer:";

/// The key of the repository of the container with this local folder label.
pub fn key(local_folder: &str) -> String {
    format!("{KEY_PREFIX}{local_folder}")
}

/// The local folder label of a dev container's key; none for a folder's path.
pub fn local_folder_of(key: &str) -> Option<&str> {
    key.strip_prefix(KEY_PREFIX).filter(|f| !f.is_empty())
}

fn words(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

/// `--bundles <dir>` when the app carries the Linux CLI bundles (Windows and macOS builds).
fn bundles_option(bundles: Option<&Path>) -> Vec<String> {
    bundles
        .map(|b| vec!["--bundles".to_string(), b.to_string_lossy().to_string()])
        .unwrap_or_default()
}

pub fn list_args() -> Vec<String> {
    words(&["devcontainer", "list", "--json"])
}

pub fn start_args(local_folder: &str) -> Vec<String> {
    words(&["devcontainer", "start", local_folder, "--json"])
}

pub fn install_args(local_folder: &str, bundles: Option<&Path>) -> Vec<String> {
    let mut a = words(&["devcontainer", "install", local_folder, "--json"]);
    a.extend(bundles_option(bundles));
    a
}

/// `metator <inner…>` in the container (installed first when needed); `inner` are the round-20
/// command lines (`inspect`, `setup`, `setup --commit`), unchanged.
pub fn run_args(local_folder: &str, bundles: Option<&Path>, inner: &[String]) -> Vec<String> {
    let mut a = words(&["devcontainer", "run", local_folder, "--json"]);
    a.extend(bundles_option(bundles));
    a.push("--".to_string());
    a.extend(inner.iter().cloned());
    a
}

/// `git -C <path> init` in the container, as its user.
pub fn git_init_args(local_folder: &str, path: &str) -> Vec<String> {
    words(&[
        "devcontainer",
        "exec",
        local_folder,
        "--json",
        "--",
        "git",
        "-C",
        path,
        "init",
    ])
}

/// The daemon of the repository at `path` in the container, and the command that tunnels to it.
pub fn serve_args(local_folder: &str, path: Option<&str>, bundles: Option<&Path>) -> Vec<String> {
    let mut a = words(&["devcontainer", "serve", local_folder, "--json"]);
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        a.extend(words(&["--path", p]));
    }
    a.extend(bundles_option(bundles));
    a
}

/// What `devcontainer exec` answered for `git init`: nothing, or why it failed.
pub fn git_init_result(data: &Value) -> Result<(), ShellError> {
    if data.get("exitCode").and_then(Value::as_i64) == Some(0) {
        return Ok(());
    }
    let said = data
        .get("stderr")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    Err(ShellError::new(
        "COMMAND_FAILED",
        &format!("git init failed in the container: {said}"),
    ))
}

/// The command each connection of the forwarder runs (`devcontainer serve`'s `tunnel`).
pub fn tunnel_of(data: &Value) -> Result<Vec<String>, ShellError> {
    let argv: Vec<String> = data
        .get("tunnel")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if argv.len() < 2 {
        return Err(ShellError::new(
            "COMMAND_FAILED",
            "metator devcontainer serve answered no tunnel",
        ));
    }
    Ok(argv)
}

/// The listed container of a local folder label (exactly that label).
pub fn listed<'a>(list: &'a Value, local_folder: &str) -> Result<&'a Value, ShellError> {
    list.get("containers")
        .and_then(Value::as_array)
        .and_then(|all| {
            let mine: Vec<&Value> = all
                .iter()
                .filter(|c| c.get("localFolder").and_then(Value::as_str) == Some(local_folder))
                .collect();
            mine.iter()
                .find(|c| c.get("state").and_then(Value::as_str) == Some("running"))
                .or(mine.first())
                .copied()
        })
        .ok_or_else(|| {
            ShellError::new(
                "CONTAINER_MISSING",
                &format!("no dev container of {local_folder} was found"),
            )
            .hint("Open the folder once in VS Code (Reopen in Container), or run `devcontainer up`, then try again.")
        })
}

/// Only VS Code's own links open on this computer (`vscode://`, `vscode-insiders://`).
pub fn check_uri(uri: &str) -> Result<(), ShellError> {
    let lower = uri.trim().to_ascii_lowercase();
    if lower.starts_with("vscode://") || lower.starts_with("vscode-insiders://") {
        return Ok(());
    }
    Err(ShellError::new(
        "USAGE",
        &format!("the app opens only VS Code's links, not {uri}"),
    ))
}

/// A loopback address of the forwarder.
pub fn local_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_dev_containers_key_is_its_local_folder_label_and_never_a_folder() {
        assert_eq!(key("c:\\work\\shop"), "devcontainer:c:\\work\\shop");
        assert_eq!(
            local_folder_of("devcontainer:c:\\work\\shop"),
            Some("c:\\work\\shop")
        );
        assert_eq!(local_folder_of("/work/shop"), None);
        assert_eq!(local_folder_of("devcontainer:"), None);
    }

    #[test]
    fn each_command_line_keeps_the_folder_whole_and_the_bundles_when_the_app_has_them() {
        let b = Path::new("/app/linux-cli");
        assert_eq!(list_args(), ["devcontainer", "list", "--json"]);
        assert_eq!(
            start_args("C:\\my shop"),
            ["devcontainer", "start", "C:\\my shop", "--json"]
        );
        assert_eq!(
            install_args("/w/shop", Some(b)),
            [
                "devcontainer",
                "install",
                "/w/shop",
                "--json",
                "--bundles",
                "/app/linux-cli"
            ]
        );
        assert_eq!(
            install_args("/w/shop", None),
            ["devcontainer", "install", "/w/shop", "--json"]
        );
        assert_eq!(
            run_args(
                "/w/shop",
                None,
                &["inspect".to_string(), "/workspaces/shop".to_string()]
            ),
            [
                "devcontainer",
                "run",
                "/w/shop",
                "--json",
                "--",
                "inspect",
                "/workspaces/shop"
            ]
        );
        assert_eq!(
            git_init_args("/w/shop", "/workspaces/new"),
            [
                "devcontainer",
                "exec",
                "/w/shop",
                "--json",
                "--",
                "git",
                "-C",
                "/workspaces/new",
                "init"
            ]
        );
        assert_eq!(
            serve_args("/w/shop", Some("/workspaces/shop"), Some(b)),
            [
                "devcontainer",
                "serve",
                "/w/shop",
                "--json",
                "--path",
                "/workspaces/shop",
                "--bundles",
                "/app/linux-cli"
            ]
        );
        assert_eq!(
            serve_args("/w/shop", Some(""), None),
            ["devcontainer", "serve", "/w/shop", "--json"]
        );
    }

    #[test]
    fn git_init_in_a_container_is_its_exit_code() {
        assert!(git_init_result(&json!({"exitCode": 0, "stdout": "Initialized"})).is_ok());
        let e = git_init_result(&json!({"exitCode": 128, "stderr": "fatal: no permission\n"}))
            .unwrap_err();
        assert_eq!(
            e.message,
            "git init failed in the container: fatal: no permission"
        );
        assert!(git_init_result(&json!({})).is_err());
    }

    #[test]
    fn the_tunnel_and_the_listed_container_are_read_from_the_answers() {
        let served = json!({"tunnel": ["/usr/bin/docker", "exec", "-i", "c1"], "port": 4711});
        assert_eq!(tunnel_of(&served).unwrap()[0], "/usr/bin/docker");
        assert_eq!(
            tunnel_of(&json!({"tunnel": []})).unwrap_err().code,
            "COMMAND_FAILED"
        );
        let list = json!({"containers": [
            {"id": "old", "localFolder": "/w/shop", "state": "stopped"},
            {"id": "new", "localFolder": "/w/shop", "state": "running"},
            {"id": "api", "localFolder": "/w/api", "state": "stopped"}
        ]});
        assert_eq!(listed(&list, "/w/shop").unwrap()["id"], "new");
        assert_eq!(listed(&list, "/w/api").unwrap()["id"], "api");
        assert_eq!(
            listed(&list, "/w/none").unwrap_err().code,
            "CONTAINER_MISSING"
        );
        assert_eq!(
            listed(&json!({"engine": null}), "/w/shop")
                .unwrap_err()
                .code,
            "CONTAINER_MISSING"
        );
    }

    #[test]
    fn only_vscode_links_are_opened() {
        assert!(check_uri("vscode://vscode-remote/dev-container+2f77/w:3").is_ok());
        assert!(check_uri("VSCode-Insiders://x").is_ok());
        for bad in ["https://example.com", "file:///etc/passwd", "cmd.exe", ""] {
            assert_eq!(check_uri(bad).unwrap_err().code, "USAGE");
        }
        assert_eq!(local_url(4711), "http://127.0.0.1:4711");
    }
}
