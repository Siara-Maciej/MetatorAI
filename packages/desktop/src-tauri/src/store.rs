//! The app's own files in its data folder (ADR-0105): the repositories it knows (`repos.json`) and
//! the person's settings (`settings.json`). Each is a versioned document (ADR-0016): `kind` and
//! `schemaVersion` first; one written by a newer app is refused, never overwritten.

use crate::cli::Choice;
use crate::envelope::ShellError;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const REPOS_KIND: &str = "DesktopRepos";
pub const SETTINGS_KIND: &str = "DesktopSettings";
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownRepo {
    /// Its key: a folder's absolute path; for a dev container, `devcontainer:<local folder>`.
    pub path: String,
    pub name: String,
    /// "repo", "folder" (a folder of repositories) or "devcontainer" (ADR-0106).
    pub kind: String,
    pub added_at: String,
    /// kind "devcontainer": the container, known by its local folder label (stable across rebuilds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub devcontainer: Option<KnownDevContainer>,
}

/// A repository in a dev container (ADR-0106). The container's id is not kept: it changes when the
/// container is rebuilt, so it is looked up by the label on each connect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownDevContainer {
    /// The `devcontainer.local_folder` label.
    pub local_folder: String,
    /// The repository inside the container (absolute there).
    pub workspace_folder: String,
    #[serde(default)]
    pub config_file: Option<String>,
    /// `vscode://vscode-remote/dev-container+<hex>`: VS Code on this computer, attached to it.
    #[serde(default)]
    pub editor_uri: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReposDocument {
    kind: String,
    schema_version: u32,
    repos: Vec<KnownRepo>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsDocument {
    kind: String,
    schema_version: u32,
    #[serde(default)]
    cli: Choice,
}

/// The header check every document of the app passes: its kind, and a version this app reads.
fn header(text: &str, kind: &str, file: &str) -> Result<serde_json::Value, ShellError> {
    let raw: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| ShellError::new("IO", &format!("{file} is not JSON: {e}")))?;
    let found = raw.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    if found != kind {
        return Err(ShellError::new(
            "IO",
            &format!("{file}: expected kind \"{kind}\", found \"{found}\""),
        ));
    }
    let version = raw
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if version > SCHEMA_VERSION as u64 {
        return Err(ShellError::new(
            "NEWER_FILE",
            &format!(
                "{file}: schemaVersion {version} is newer than this app reads ({SCHEMA_VERSION})"
            ),
        )
        .hint("A newer MetatorAI app wrote it: update the app."));
    }
    if version < 1 {
        return Err(ShellError::new(
            "IO",
            &format!("{file}: unsupported schemaVersion {version}"),
        ));
    }
    Ok(raw)
}

/// The known repositories in the order added; none when the file is not there yet.
pub fn read_repos(text: Option<&str>) -> Result<Vec<KnownRepo>, ShellError> {
    let Some(text) = text else { return Ok(vec![]) };
    let raw = header(text, REPOS_KIND, "repos.json")?;
    let doc: ReposDocument = serde_json::from_value(raw)
        .map_err(|e| ShellError::new("IO", &format!("repos.json: {e}")))?;
    Ok(doc.repos)
}

pub fn write_repos(repos: &[KnownRepo]) -> String {
    let doc = ReposDocument {
        kind: REPOS_KIND.to_string(),
        schema_version: SCHEMA_VERSION,
        repos: repos.to_vec(),
    };
    format!(
        "{}\n",
        serde_json::to_string_pretty(&doc).expect("repos serialize")
    )
}

/// The folder's name, the last part of its path.
pub fn name_of(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_string()
}

/// A repository added: the list with it last, and the entry; one already there is kept as it was.
pub fn add(repos: &[KnownRepo], path: &str, kind: &str, now: &str) -> (Vec<KnownRepo>, KnownRepo) {
    if let Some(known) = repos.iter().find(|r| same(&r.path, path)) {
        return (repos.to_vec(), known.clone());
    }
    let entry = KnownRepo {
        path: path.to_string(),
        name: name_of(path),
        kind: kind.to_string(),
        added_at: now.to_string(),
        devcontainer: None,
    };
    let mut out = repos.to_vec();
    out.push(entry.clone());
    (out, entry)
}

/// A dev container's repository added (ADR-0106): keyed by the container's local folder label and
/// named after that folder ("shop", shown "shop (Dev Container)"); one already there is kept as it was.
pub fn add_devcontainer(
    repos: &[KnownRepo],
    container: KnownDevContainer,
    now: &str,
) -> (Vec<KnownRepo>, KnownRepo) {
    let key = crate::devcontainer::key(&container.local_folder);
    if let Some(known) = repos.iter().find(|r| r.path == key) {
        return (repos.to_vec(), known.clone());
    }
    let entry = KnownRepo {
        path: key,
        name: name_of(&container.local_folder),
        kind: "devcontainer".to_string(),
        added_at: now.to_string(),
        devcontainer: Some(container),
    };
    let mut out = repos.to_vec();
    out.push(entry.clone());
    (out, entry)
}

/// What a folder the person adds is: "folder" with a `metator.repos.yml` or git repositories one
/// level below (`children`: its sub-folders), "repo" with a `.git` (a folder, or a worktree's file);
/// anything else is refused, as the inspection said.
pub fn kind_of(
    path: &Path,
    children: &[std::path::PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Result<&'static str, ShellError> {
    if !exists(path) {
        return Err(ShellError::new(
            "NOT_FOUND",
            &format!("no folder at {}", path.display()),
        ));
    }
    if exists(&path.join("metator.repos.yml")) {
        return Ok("folder");
    }
    if exists(&path.join(".git")) {
        return Ok("repo");
    }
    if children.iter().any(|c| exists(&c.join(".git"))) {
        return Ok("folder");
    }
    Err(ShellError::new(
        "USAGE",
        &format!(
            "{} is not a git repository nor a folder of repositories",
            path.display()
        ),
    )
    .hint("Inspect it first: the app offers git init for a plain folder."))
}

/// A repository forgotten (its files stay where they are).
pub fn remove(repos: &[KnownRepo], path: &str) -> Vec<KnownRepo> {
    repos
        .iter()
        .filter(|r| !same(&r.path, path))
        .cloned()
        .collect()
}

/// The same folder, whatever separator ends it.
fn same(a: &str, b: &str) -> bool {
    a.trim_end_matches(['/', '\\']) == b.trim_end_matches(['/', '\\'])
}

pub fn read_settings(text: Option<&str>) -> Result<Choice, ShellError> {
    let Some(text) = text else {
        return Ok(Choice::default());
    };
    let raw = header(text, SETTINGS_KIND, "settings.json")?;
    let doc: SettingsDocument = serde_json::from_value(raw)
        .map_err(|e| ShellError::new("IO", &format!("settings.json: {e}")))?;
    Ok(doc.cli)
}

pub fn write_settings(cli: &Choice) -> String {
    let doc = SettingsDocument {
        kind: SETTINGS_KIND.to_string(),
        schema_version: SCHEMA_VERSION,
        cli: cli.clone(),
    };
    format!(
        "{}\n",
        serde_json::to_string_pretty(&doc).expect("settings serialize")
    )
}

/// A time as ISO 8601 in UTC (`2026-11-23T10:00:00Z`), from seconds since 1970 (days to a civil date, H. Hinnant's way).
pub fn iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// A file's text, or none when it is not there.
pub fn read_file(path: &Path) -> Result<Option<String>, ShellError> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ShellError::new(
            "IO",
            &format!("cannot read {}: {e}", path.display()),
        )),
    }
}

/// Written whole or not at all: a temporary file beside it, renamed over it.
pub fn write_file(path: &Path, text: &str) -> Result<(), ShellError> {
    let io =
        |e: std::io::Error| ShellError::new("IO", &format!("cannot write {}: {e}", path.display()));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(io)?;
    std::fs::rename(&tmp, path).map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Source;

    #[test]
    fn repositories_are_added_once_in_order_and_forgotten_without_touching_files() {
        let (one, a) = add(&[], "/work/shop", "repo", "2026-11-23T10:00:00Z");
        assert_eq!(a.name, "shop");
        let (two, b) = add(&one, "/work/all/", "folder", "2026-11-23T10:01:00Z");
        assert_eq!((b.name.as_str(), b.kind.as_str()), ("all", "folder"));
        let (again, same_one) = add(&two, "/work/shop/", "repo", "2026-11-24T00:00:00Z");
        assert_eq!(again, two);
        assert_eq!(same_one.added_at, "2026-11-23T10:00:00Z");
        assert_eq!(
            remove(&two, "/work/shop")
                .iter()
                .map(|r| r.path.as_str())
                .collect::<Vec<_>>(),
            ["/work/all/"]
        );
        assert_eq!(name_of("C:\\work\\shop"), "shop");
    }

    #[test]
    fn a_dev_containers_repository_is_keyed_by_its_local_folder_and_reads_back() {
        let dc = |ws: &str| KnownDevContainer {
            local_folder: "c:\\work\\shop".to_string(),
            workspace_folder: ws.to_string(),
            config_file: Some("c:\\work\\shop\\.devcontainer\\devcontainer.json".to_string()),
            editor_uri: "vscode://vscode-remote/dev-container+633a".to_string(),
        };
        let (one, _) = add(&[], "c:\\work\\shop", "repo", "2026-11-23T10:00:00Z");
        let (two, entry) = add_devcontainer(&one, dc("/workspaces/shop"), "2026-11-23T10:01:00Z");
        assert_eq!(
            (
                entry.path.as_str(),
                entry.name.as_str(),
                entry.kind.as_str()
            ),
            ("devcontainer:c:\\work\\shop", "shop", "devcontainer")
        );
        // The same folder on this computer stays a separate entry.
        assert_eq!(two.len(), 2);
        let (again, kept) = add_devcontainer(&two, dc("/elsewhere"), "2026-11-24T00:00:00Z");
        assert_eq!(again, two);
        assert_eq!(
            kept.devcontainer.unwrap().workspace_folder,
            "/workspaces/shop"
        );
        let text = write_repos(&two);
        assert!(text.contains("\"workspaceFolder\": \"/workspaces/shop\""));
        assert!(text.contains("\"editorUri\""));
        assert_eq!(read_repos(Some(&text)).unwrap(), two);
        // A round-20 entry has no devcontainer field, and still reads.
        assert!(!write_repos(&one).contains("devcontainer"));
        assert_eq!(
            remove(&two, "devcontainer:c:\\work\\shop")
                .iter()
                .map(|r| r.kind.as_str())
                .collect::<Vec<_>>(),
            ["repo"]
        );
    }

    #[test]
    fn a_folder_added_is_a_repository_a_folder_of_them_or_refused() {
        let there =
            |want: &'static [&'static str]| move |p: &Path| want.iter().any(|w| Path::new(w) == p);
        let none: &[std::path::PathBuf] = &[];
        assert_eq!(
            kind_of(
                Path::new("/w/shop"),
                none,
                there(&["/w/shop", "/w/shop/.git"])
            ),
            Ok("repo")
        );
        assert_eq!(
            kind_of(
                Path::new("/w"),
                none,
                there(&["/w", "/w/metator.repos.yml", "/w/.git"])
            ),
            Ok("folder")
        );
        let kids = [
            std::path::PathBuf::from("/w/api"),
            std::path::PathBuf::from("/w/web"),
        ];
        assert_eq!(
            kind_of(Path::new("/w"), &kids, there(&["/w", "/w/web/.git"])),
            Ok("folder")
        );
        assert_eq!(
            kind_of(Path::new("/w"), &kids, there(&["/w"]))
                .unwrap_err()
                .code,
            "USAGE"
        );
        assert_eq!(
            kind_of(Path::new("/gone"), none, there(&[]))
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
    }

    #[test]
    fn the_repos_file_is_a_versioned_document_and_reads_back() {
        let (repos, _) = add(&[], "/work/shop", "repo", "2026-11-23T10:00:00Z");
        let text = write_repos(&repos);
        assert!(text.starts_with("{\n  \"kind\": \"DesktopRepos\",\n  \"schemaVersion\": 1,"));
        assert!(text.contains("\"addedAt\": \"2026-11-23T10:00:00Z\""));
        assert_eq!(read_repos(Some(&text)).unwrap(), repos);
        assert_eq!(read_repos(None).unwrap(), vec![]);
    }

    #[test]
    fn a_newer_or_foreign_file_is_refused() {
        let newer = r#"{"kind":"DesktopRepos","schemaVersion":2,"repos":[]}"#;
        assert_eq!(read_repos(Some(newer)).unwrap_err().code, "NEWER_FILE");
        assert!(read_repos(Some(r#"{"kind":"Other","schemaVersion":1}"#))
            .unwrap_err()
            .message
            .contains("expected kind"));
        assert!(read_repos(Some("not json")).is_err());
        assert!(read_repos(Some(
            r#"{"kind":"DesktopRepos","schemaVersion":0,"repos":[]}"#
        ))
        .is_err());
    }

    #[test]
    fn settings_keep_the_cli_choice() {
        let choice = Choice {
            source: Source::Custom,
            path: Some("/w/metator".to_string()),
        };
        let text = write_settings(&choice);
        assert!(text.contains("\"kind\": \"DesktopSettings\""));
        assert_eq!(read_settings(Some(&text)).unwrap(), choice);
        assert_eq!(read_settings(None).unwrap(), Choice::default());
        assert_eq!(
            read_settings(Some(r#"{"kind":"DesktopSettings","schemaVersion":1}"#)).unwrap(),
            Choice::default()
        );
    }

    #[test]
    fn times_are_iso_8601_in_utc() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601(1_795_431_845), "2026-11-23T11:04:05Z");
    }

    #[test]
    fn files_are_written_whole_and_read_back() {
        let dir = std::env::temp_dir().join(format!("metator-store-{}", std::process::id()));
        let file = dir.join("nested").join("repos.json");
        assert_eq!(read_file(&file).unwrap(), None);
        write_file(&file, "{}\n").unwrap();
        assert_eq!(read_file(&file).unwrap().as_deref(), Some("{}\n"));
        assert!(!file.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
