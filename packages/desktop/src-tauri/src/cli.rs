//! Which `metator` the app runs (ADR-0105): the one bundled with the app, unless the person chose
//! another in Settings (a developer running from a checkout). `$METATOR_BIN` still wins, as before.

use crate::envelope::ShellError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    Bundled,
    Path,
    Custom,
}

/// The program the app runs and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub source: Source,
    pub program: PathBuf,
}

/// What the person chose in Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Choice {
    pub source: Source,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// The program, from the choice and what is there: `bundled` is the sidecar when it exists,
/// `on_path` is `metator` found on the composed PATH. The bundled one is never silently replaced
/// by another the person did not choose, except in a build that has none (a developer's).
pub fn resolve(
    choice: &Choice,
    env_bin: Option<&str>,
    bundled: Option<PathBuf>,
    on_path: Option<PathBuf>,
) -> Result<Resolved, ShellError> {
    if let Some(bin) = env_bin.map(str::trim).filter(|b| !b.is_empty()) {
        return Ok(Resolved {
            source: Source::Custom,
            program: PathBuf::from(bin),
        });
    }
    match choice.source {
        Source::Custom => match choice.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => Ok(Resolved { source: Source::Custom, program: PathBuf::from(p) }),
            None => Err(ShellError::new("NO_CLI", "the chosen metator program has no path")
                .hint("Choose the program again in Settings, or go back to the bundled one.")),
        },
        Source::Path => on_path
            .map(|program| Resolved { source: Source::Path, program })
            .ok_or_else(|| {
                ShellError::new("NO_CLI", "no metator on your PATH")
                    .hint("Install it (npm install -g metator-ai, or bun link in a checkout), or use the bundled one in Settings.")
            }),
        Source::Bundled => match (bundled, on_path) {
            (Some(program), _) => Ok(Resolved { source: Source::Bundled, program }),
            (None, Some(program)) => Ok(Resolved { source: Source::Path, program }),
            (None, None) => Err(ShellError::new("NO_CLI", "this build of the app has no bundled metator and none is on your PATH")
                .hint("Reinstall the app, or install metator (npm install -g metator-ai).")),
        },
    }
}

/// A custom program the person chose must be there before it is kept.
pub fn check_custom(path: &str, exists: impl Fn(&Path) -> bool) -> Result<(), ShellError> {
    if path.trim().is_empty() || !exists(Path::new(path.trim())) {
        return Err(ShellError::new("NOT_FOUND", &format!("no program at {path}"))
            .hint("Choose the metator program itself (a checkout's is packages/cli/src/main.ts run by bun: use a launcher script)."));
    }
    Ok(())
}

/// `metator inspect <path>`: what the folder is (read only).
pub fn inspect_args(path: &str) -> Vec<String> {
    ["inspect", path, "--json"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// `metator -C <path> setup --host <host> --yes`: setup without questions.
pub fn setup_args(path: &str, host: &str) -> Vec<String> {
    ["-C", path, "setup", "--host", host, "--yes", "--json"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// `metator -C <path> setup --commit --files <files…>`: exactly these files, as "Set up MetatorAI".
pub fn commit_args(path: &str, files: &[String]) -> Vec<String> {
    let mut args: Vec<String> = ["-C", path, "setup", "--commit", "--json", "--files"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.extend(files.iter().cloned());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_command_line_keeps_a_path_whole_and_commits_only_the_files_named() {
        assert_eq!(
            inspect_args("/w/my shop"),
            ["inspect", "/w/my shop", "--json"]
        );
        assert_eq!(
            setup_args("/w/my shop", "claude"),
            [
                "-C",
                "/w/my shop",
                "setup",
                "--host",
                "claude",
                "--yes",
                "--json"
            ]
        );
        assert_eq!(
            commit_args("/w", &["a b.md".to_string(), "--json".to_string()]),
            ["-C", "/w", "setup", "--commit", "--json", "--files", "a b.md", "--json"]
        );
    }

    fn choice(source: Source, path: Option<&str>) -> Choice {
        Choice {
            source,
            path: path.map(str::to_string),
        }
    }

    #[test]
    fn the_bundled_cli_first_and_another_only_when_chosen() {
        let bundled = Some(PathBuf::from("/app/metator"));
        let on_path = Some(PathBuf::from("/usr/local/bin/metator"));
        let r = resolve(&Choice::default(), None, bundled.clone(), on_path.clone()).unwrap();
        assert_eq!(
            (r.source, r.program),
            (Source::Bundled, PathBuf::from("/app/metator"))
        );
        let r = resolve(
            &choice(Source::Path, None),
            None,
            bundled.clone(),
            on_path.clone(),
        )
        .unwrap();
        assert_eq!(
            (r.source, r.program),
            (Source::Path, PathBuf::from("/usr/local/bin/metator"))
        );
        let r = resolve(
            &choice(Source::Custom, Some("/w/metator")),
            None,
            bundled.clone(),
            on_path,
        )
        .unwrap();
        assert_eq!(
            (r.source, r.program),
            (Source::Custom, PathBuf::from("/w/metator"))
        );
    }

    #[test]
    fn metator_bin_wins_and_a_build_without_a_sidecar_takes_the_path() {
        let r = resolve(
            &Choice::default(),
            Some("/dev/metator"),
            Some(PathBuf::from("/app/metator")),
            None,
        )
        .unwrap();
        assert_eq!(
            (r.source, r.program),
            (Source::Custom, PathBuf::from("/dev/metator"))
        );
        let r = resolve(
            &Choice::default(),
            Some(" "),
            None,
            Some(PathBuf::from("/p/metator")),
        )
        .unwrap();
        assert_eq!(r.source, Source::Path);
    }

    #[test]
    fn nothing_to_run_says_what_to_do() {
        let e = resolve(&Choice::default(), None, None, None).unwrap_err();
        assert_eq!(e.code, "NO_CLI");
        let e = resolve(
            &choice(Source::Path, None),
            None,
            Some(PathBuf::from("/app/metator")),
            None,
        )
        .unwrap_err();
        assert!(e.message.contains("PATH"));
        let e = resolve(&choice(Source::Custom, Some("")), None, None, None).unwrap_err();
        assert_eq!(e.code, "NO_CLI");
    }

    #[test]
    fn a_custom_program_must_be_there() {
        assert!(check_custom("/w/metator", |p| p == Path::new("/w/metator")).is_ok());
        assert_eq!(
            check_custom("/nowhere", |_| false).unwrap_err().code,
            "NOT_FOUND"
        );
        assert!(check_custom(" ", |_| true).is_err());
    }

    #[test]
    fn a_choice_reads_and_writes_as_lowercase_words() {
        let c: Choice = serde_json::from_str(r#"{"source":"custom","path":"/w/m"}"#).unwrap();
        assert_eq!(c, choice(Source::Custom, Some("/w/m")));
        assert_eq!(
            serde_json::to_string(&Choice::default()).unwrap(),
            r#"{"source":"bundled"}"#
        );
    }
}
