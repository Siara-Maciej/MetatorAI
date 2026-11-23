//! The Linux CLI bundle the Windows and macOS apps carry (ADR-0105): the compiled `metator` for
//! Linux with its native addons and a launcher, one tarball per architecture, which the next round
//! copies into a Dev Container and runs there. The app only finds it: `linux-cli/<arch>/` in its
//! resources holds the tarball and its manifest, a versioned document (ADR-0016).

use crate::envelope::ShellError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The manifest's kind and the version this app reads.
pub const MANIFEST_KIND: &str = "LinuxCliBundle";
pub const MANIFEST_VERSION: u64 = 1;
/// The manifest's file, beside the tarball.
pub const MANIFEST_FILE: &str = "metator-bundle.json";
/// The folder in the app's resources that holds one folder per architecture.
pub const RESOURCES_DIR: &str = "linux-cli";

/// The architecture as the bundle names it, from what a person, Docker (`amd64`) or `uname -m`
/// (`x86_64`, `aarch64`) says; none for one the app has no bundle for.
pub fn arch(name: &str) -> Option<&'static str> {
    match name.trim().to_ascii_lowercase().as_str() {
        "x64" | "x86_64" | "amd64" => Some("x64"),
        "arm64" | "aarch64" => Some("arm64"),
        _ => None,
    }
}

/// What the manifest says (the fields the app uses).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    kind: String,
    schema_version: u64,
    version: String,
    arch: String,
    tarball: String,
    entry: String,
    sha256: String,
    glibc: String,
}

/// The bundle as `linux_cli_bundle` answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    /// The tarball, absolute: what is copied into the container and unpacked there.
    pub path: String,
    /// The CLI's version (the app's: they are built together).
    pub version: String,
    /// "x64" or "arm64".
    pub arch: String,
    /// The launcher inside the tarball, relative to where it is unpacked (`metator-linux-x64/bin/metator`).
    pub entry: String,
    /// The tarball's SHA-256: a copy in a container is checked against it.
    pub sha256: String,
    /// The oldest glibc it runs on (`2.31`): a container with an older one cannot run it.
    pub glibc: String,
}

/// The bundle for `arch` from the app's resources folder, read from its manifest.
pub fn find(
    resource_dir: Option<&Path>,
    wanted: &str,
    read: impl Fn(&Path) -> Option<String>,
    exists: impl Fn(&Path) -> bool,
) -> Result<Bundle, ShellError> {
    let Some(a) = arch(wanted) else {
        return Err(ShellError::new(
            "USAGE",
            &format!("no Linux CLI bundle for the architecture \"{wanted}\""),
        )
        .hint("One of x64 (x86_64, amd64) or arm64 (aarch64)."));
    };
    let missing = |what: String| {
        ShellError::new("NOT_FOUND", &what).hint("This build of the app carries no Linux CLI: the Windows and macOS builds do. Reinstall the app.")
    };
    let Some(resources) = resource_dir else {
        return Err(missing("the app has no resources folder".to_string()));
    };
    let dir: PathBuf = resources.join(RESOURCES_DIR).join(a);
    let file = dir.join(MANIFEST_FILE);
    let text = read(&file).ok_or_else(|| {
        missing(format!(
            "no Linux CLI bundle for {a}: {} is not there",
            file.display()
        ))
    })?;
    let raw: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| ShellError::new("IO", &format!("{}: not JSON: {e}", file.display())))?;
    let kind = raw.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    if kind != MANIFEST_KIND {
        return Err(ShellError::new(
            "IO",
            &format!(
                "{}: expected kind \"{MANIFEST_KIND}\", found \"{kind}\"",
                file.display()
            ),
        ));
    }
    let version = raw
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if version != MANIFEST_VERSION {
        return Err(ShellError::new(
            "NEWER_FILE",
            &format!(
                "{}: schemaVersion {version}, this app reads {MANIFEST_VERSION}",
                file.display()
            ),
        )
        .hint("The app and its Linux CLI were built apart: reinstall the app."));
    }
    let m: Manifest = serde_json::from_value(raw)
        .map_err(|e| ShellError::new("IO", &format!("{}: {e}", file.display())))?;
    if m.arch != a {
        return Err(ShellError::new(
            "IO",
            &format!(
                "{}: a bundle for {}, in the folder of {a}",
                file.display(),
                m.arch
            ),
        ));
    }
    let tarball = dir.join(&m.tarball);
    if !exists(&tarball) {
        return Err(missing(format!(
            "the Linux CLI's tarball is not there: {}",
            tarball.display()
        )));
    }
    Ok(Bundle {
        path: tarball.to_string_lossy().to_string(),
        version: m.version,
        arch: m.arch,
        entry: m.entry,
        sha256: m.sha256,
        glibc: m.glibc,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn manifest(arch: &str) -> String {
        format!(
            r#"{{"kind":"LinuxCliBundle","schemaVersion":1,"version":"0.4.0","platform":"linux","arch":"{arch}","tarball":"metator-linux-{arch}.tar.gz","entry":"metator-linux-{arch}/bin/metator","sha256":"00ff","glibc":"2.31"}}"#
        )
    }

    /// A find over these files only.
    fn find_in(
        dir: Option<&str>,
        wanted: &str,
        entries: &[(&str, String)],
    ) -> Result<Bundle, ShellError> {
        let map: HashMap<PathBuf, String> = entries
            .iter()
            .map(|(p, t)| (PathBuf::from(p), t.clone()))
            .collect();
        find(
            dir.map(Path::new),
            wanted,
            |p| map.get(p).cloned(),
            |p| map.contains_key(p),
        )
    }

    #[test]
    fn docker_and_uname_names_are_the_bundles_architectures() {
        assert_eq!(
            [arch("x64"), arch("x86_64"), arch("AMD64"), arch(" amd64 ")],
            [Some("x64"); 4]
        );
        assert_eq!([arch("arm64"), arch("aarch64")], [Some("arm64"); 2]);
        assert_eq!([arch("riscv64"), arch("")], [None, None]);
    }

    #[test]
    fn the_bundle_is_found_by_its_manifest_in_the_resources() {
        let b = find_in(
            Some("/app/res"),
            "aarch64",
            &[
                (
                    "/app/res/linux-cli/arm64/metator-bundle.json",
                    manifest("arm64"),
                ),
                (
                    "/app/res/linux-cli/arm64/metator-linux-arm64.tar.gz",
                    "tar".to_string(),
                ),
            ],
        )
        .unwrap();
        assert_eq!(
            b,
            Bundle {
                path: "/app/res/linux-cli/arm64/metator-linux-arm64.tar.gz".to_string(),
                version: "0.4.0".to_string(),
                arch: "arm64".to_string(),
                entry: "metator-linux-arm64/bin/metator".to_string(),
                sha256: "00ff".to_string(),
                glibc: "2.31".to_string(),
            }
        );
        assert_eq!(
            serde_json::to_value(&b).unwrap()["entry"],
            serde_json::json!("metator-linux-arm64/bin/metator")
        );
    }

    #[test]
    fn a_missing_bundle_or_tarball_says_so_and_a_wrong_name_is_refused() {
        let none = find_in(Some("/app/res"), "x64", &[]).unwrap_err();
        assert_eq!(none.code, "NOT_FOUND");
        assert!(none.message.contains("linux-cli/x64/metator-bundle.json"));
        assert_eq!(find_in(None, "x64", &[]).unwrap_err().code, "NOT_FOUND");
        let no_tar = find_in(
            Some("/app/res"),
            "x64",
            &[(
                "/app/res/linux-cli/x64/metator-bundle.json",
                manifest("x64"),
            )],
        )
        .unwrap_err();
        assert!(no_tar.message.contains("tarball"));
        assert_eq!(
            find_in(Some("/app/res"), "sparc", &[]).unwrap_err().code,
            "USAGE"
        );
    }

    #[test]
    fn a_manifest_of_another_kind_version_or_architecture_is_refused() {
        let at = "/r/linux-cli/x64/metator-bundle.json";
        let tar = "/r/linux-cli/x64/metator-linux-x64.tar.gz";
        let with = |text: String| {
            find_in(Some("/r"), "x64", &[(at, text), (tar, String::new())]).unwrap_err()
        };
        assert!(with(manifest("x64").replace("LinuxCliBundle", "Other"))
            .message
            .contains("expected kind"));
        assert_eq!(
            with(manifest("x64").replace("\"schemaVersion\":1", "\"schemaVersion\":2")).code,
            "NEWER_FILE"
        );
        assert!(with(manifest("arm64"))
            .message
            .contains("a bundle for arm64"));
        assert_eq!(with("not json".to_string()).code, "IO");
    }
}
