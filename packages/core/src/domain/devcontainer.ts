import { MetatorError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

/**
 * Dev Containers (ADR-0106): the app on Windows or macOS shows the window, and everything else runs
 * in the person's dev container. The decisions are here, pure: which containers are dev
 * containers and what they are (labels, mounts, the devcontainer metadata), which user and
 * environment their processes get, what a probe of the container says, whether the Linux CLI
 * bundle must be copied in, and the links that open VS Code attached to the container. The
 * engine (`docker` or `nerdctl`) is reached through the `ContainerEngine` port.
 */

/** The labels the Dev Containers extension and the devcontainer CLI put on a container they make. */
export const DEVCONTAINER_LABEL = {
  localFolder: "devcontainer.local_folder",
  configFile: "devcontainer.config_file",
  metadata: "devcontainer.metadata",
} as const;

/** What the engine says of one container (`inspect`), as the adapter reads it. */
export interface ContainerDetails {
  readonly id: string;
  /** Without docker's leading "/". */
  readonly name: string;
  readonly image: string;
  /** The engine's word: running, exited, created, paused, restarting, dead. */
  readonly state: string;
  /** The image's (or `--user`'s) user: a name, a uid, "uid:gid"; "" for root. */
  readonly user: string;
  readonly labels: Readonly<Record<string, string>>;
  /** The container's environment, `NAME=value`. */
  readonly env: readonly string[];
  readonly mounts: readonly ContainerMount[];
  /** The `devcontainer.metadata` label read as JSON: one object per feature and config, in order; empty without it. */
  readonly metadata: readonly Readonly<Record<string, unknown>>[];
}

/** A program run in a container (`ContainerEngine.exec`). */
export interface ContainerCommand {
  /** Who runs it: a user name or uid of the container. */
  readonly user: string;
  readonly argv: readonly string[];
  /** Its working folder in the container; the container's own when not given. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** "capture" (default): its stderr comes back; "inherit": it goes to this process's own stderr as it comes. stdout is always captured. */
  readonly stderr?: "capture" | "inherit";
  readonly timeoutMs?: number;
}

export interface ContainerMount {
  /** bind, volume, tmpfs. */
  readonly type: string;
  /** The engine's own path of what is mounted (for a bind: as the engine's VM sees the host folder). */
  readonly source: string;
  readonly destination: string;
}

/** A dev container as the app lists it. */
export interface DevContainer {
  /** Its id now; a rebuilt container gets another, so it is looked up on each connect. */
  readonly id: string;
  readonly name: string;
  /** The `devcontainer.local_folder` label: the container's identity, stable across rebuilds. */
  readonly localFolder: string;
  readonly configFile: string | null;
  readonly state: "running" | "stopped";
  /** The workspace folder inside it; null when none can be told. */
  readonly workspaceFolder: string | null;
  /** The user every process runs as there. */
  readonly remoteUser: string;
  readonly image: string;
  /** VS Code on this computer attached to it; the path inside and `:<line>` are appended. */
  readonly editorUri: string;
}

/** The container CLI the app uses. */
export interface ContainerEngineInfo {
  readonly program: "docker" | "nerdctl";
  /** The program, absolute (what the forwarder starts for each connection). */
  readonly path: string;
  /** docker's current context; null for nerdctl. */
  readonly context: string | null;
  /** The engine's server version. */
  readonly version: string;
}

/** What asking one container CLI on this computer found. */
export interface EngineFacts {
  readonly program: "docker" | "nerdctl";
  /** The program on PATH; null when it is not installed. */
  readonly path: string | null;
  /** The server's version; null when the engine did not answer. */
  readonly version: string | null;
  readonly context: string | null;
  /** What it said when it did not answer (its last line). */
  readonly said: string;
}

/**
 * The engine to use (ADR-0106): docker when its engine answers (Docker Desktop; Rancher Desktop
 * with moby), else nerdctl when its engine answers (Rancher Desktop with containerd); none with
 * the reason when neither does.
 */
export function chooseEngine(
  facts: readonly EngineFacts[],
): { readonly engine: ContainerEngineInfo } | { readonly problem: string } {
  for (const program of ["docker", "nerdctl"] as const) {
    const f = facts.find((x) => x.program === program);
    if (f?.path && f.version)
      return { engine: { program, path: f.path, context: f.context, version: f.version } };
  }
  const installed = facts.filter((f) => f.path !== null);
  if (installed.length === 0)
    return {
      problem:
        "Neither docker nor nerdctl is installed on this computer: install Docker Desktop or Rancher Desktop.",
    };
  return {
    problem: installed
      .map(
        (f) =>
          `${f.program} is installed, but its engine does not answer${f.said ? `: ${f.said}` : ""}. Start ${
            f.program === "docker" ? "Docker Desktop or Rancher Desktop" : "Rancher Desktop"
          }.`,
      )
      .join(" "),
  };
}

/** Why something about a container failed, as the shell names it (`details.reason`). */
export type ContainerProblem =
  | "no-engine"
  | "container-missing"
  | "container-stopped"
  | "musl"
  | "unsupported";

export function containerError(reason: ContainerProblem, message: string, hint?: string): MetatorError {
  const code =
    reason === "container-missing"
      ? "NOT_FOUND"
      : reason === "no-engine"
        ? "BIN_NOT_FOUND"
        : "COMMAND_FAILED";
  return new MetatorError(code, message, { ...(hint === undefined ? {} : { hint }), details: { reason } });
}

/** The last part of a Windows or a POSIX path. */
export const lastPathPart = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;

/**
 * A host folder as a comparable key, whichever way the engine says it: `C:\Users\me\shop`
 * (the label on Windows), `/run/desktop/mnt/host/c/Users/me/shop` (Docker Desktop, WSL 2),
 * `/host_mnt/c/...` (Docker Desktop, older), `/mnt/c/...` (Rancher Desktop, WSL) and a WSL
 * share (`\\wsl.localhost\Ubuntu\home\me`) all become `c:/users/me/shop` or `/home/me`; a
 * drive's path is compared without case, as Windows does.
 */
export function hostPathKey(path: string): string {
  let p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  p = p.replace(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+/i, "");
  const vm = /^(?:\/run\/desktop\/mnt\/host|\/host_mnt|\/mnt)\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (vm) p = `${vm[1]}:${vm[2] ?? ""}`;
  const drive = /^([a-zA-Z]):(\/.*)?$/.exec(p);
  if (drive) return `${drive[1]}:${drive[2] ?? ""}`.toLowerCase();
  return p === "" ? "/" : p;
}

/** The same local folder (the label of two containers, or a label and a person's words). */
export const sameFolder = (a: string, b: string): boolean => hostPathKey(a) === hostPathKey(b);

/**
 * The workspace folder inside the container: the destination of the bind mount of the local folder
 * (or of a folder above it, then the rest of the path), else of a bind mount of a folder with the
 * same name, else the first mount under `/workspaces`; null when there is none.
 */
export function workspaceFolderOf(localFolder: string, mounts: readonly ContainerMount[]): string | null {
  const folder = hostPathKey(localFolder);
  let best: { readonly key: string; readonly at: string } | undefined;
  for (const m of mounts) {
    if (m.type !== "bind") continue;
    const key = hostPathKey(m.source);
    if (key !== folder && !folder.startsWith(`${key}/`)) continue;
    if (best && best.key.length >= key.length) continue;
    const rest = folder.slice(key.length);
    const dest = m.destination.replace(/\/+$/, "");
    best = { key, at: `${dest}${rest}` || "/" };
  }
  if (best) return best.at;
  const name = lastPathPart(localFolder).toLowerCase();
  const named = mounts.find((m) => m.type === "bind" && lastPathPart(m.source).toLowerCase() === name);
  if (named) return named.destination.replace(/\/+$/, "") || "/";
  const workspaces = mounts.find((m) => m.destination.startsWith("/workspaces/"));
  return workspaces ? workspaces.destination.replace(/\/+$/, "") : null;
}

/** The last string a metadata entry sets for `key` (later entries override earlier ones, as the extension merges them). */
function lastSet(metadata: ContainerDetails["metadata"], key: string): string | undefined {
  let found: string | undefined;
  for (const entry of metadata) {
    const v = entry[key];
    if (typeof v === "string" && v.trim() !== "") found = v.trim();
  }
  return found;
}

/** The user processes run as: `remoteUser`, else `containerUser`, else the image's user, else root. */
export function remoteUserOf(d: Pick<ContainerDetails, "metadata" | "user">): string {
  return (
    lastSet(d.metadata, "remoteUser") ?? lastSet(d.metadata, "containerUser") ?? (d.user.trim() || "root")
  );
}

/** A container's environment as a map (`NAME=value` lines; the first `=` splits). */
export function envMap(lines: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

/**
 * The `remoteEnv` of the devcontainer metadata (merged, later wins), with `${containerEnv:NAME}`
 * (and `${containerEnv:NAME:default}`) taken from the container's environment. An entry with any
 * other variable (`${localEnv:…}`, which only the extension on the host knows) or a null value
 * is left out.
 */
export function remoteEnvOf(d: Pick<ContainerDetails, "metadata" | "env">): Record<string, string> {
  const container = envMap(d.env);
  const merged: Record<string, unknown> = {};
  for (const entry of d.metadata) {
    const env = entry.remoteEnv;
    if (env && typeof env === "object" && !Array.isArray(env)) Object.assign(merged, env);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (typeof value !== "string") continue;
    let unknown = false;
    const text = value.replace(/\$\{([^}]*)\}/g, (_all, inner: string) => {
      const m = /^containerEnv:([^:]+)(?::(.*))?$/.exec(inner);
      if (!m) {
        unknown = true;
        return "";
      }
      return container[m[1] as string] ?? m[2] ?? "";
    });
    if (!unknown) out[name] = text;
  }
  return out;
}

/** UTF-8 bytes as lowercase hex. */
const hex = (text: string): string =>
  [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A file's path as a URI's path: `c:\a\b` → `/c:/a/b`. */
const uriPath = (path: string): string => {
  const p = path.replace(/\\/g, "/");
  return /^[a-zA-Z]:/.test(p) ? `/${p}` : p;
};

/** The config file the extension takes when none is named: `.devcontainer/devcontainer.json` or `.devcontainer.json`. */
export function isDefaultConfig(localFolder: string, configFile: string | null): boolean {
  if (configFile === null) return true;
  const folder = hostPathKey(localFolder);
  const file = hostPathKey(configFile);
  return file === `${folder}/.devcontainer/devcontainer.json` || file === `${folder}/.devcontainer.json`;
}

/**
 * The link that opens VS Code on this computer attached to the dev container, as the Dev Containers
 * extension names it: `vscode://vscode-remote/dev-container+<hex>`, where hex is the local folder
 * (its default config) or `{"hostPath", "configFile"}` as JSON (another config). The path inside
 * the container and `:<line>` follow it.
 */
export function editorUri(localFolder: string, configFile: string | null): string {
  const authority = isDefaultConfig(localFolder, configFile)
    ? hex(localFolder)
    : hex(
        `{"hostPath":${quote(localFolder)},"configFile":{"$mid":1,"path":${quote(uriPath(configFile as string))},"scheme":"vscode-fileHost"}}`,
      );
  return `vscode://vscode-remote/dev-container+${authority}`;
}

/** A JSON string literal, written by hand: the domain does not serialize documents. */
function quote(text: string): string {
  let out = '"';
  for (const c of text) {
    const code = c.charCodeAt(0);
    if (c === "\\" || c === '"') out += `\\${c}`;
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += c;
  }
  return `${out}"`;
}

/** A container is a dev container when it carries the local folder label; what the app lists of it. */
export function devContainerOf(d: ContainerDetails): DevContainer | undefined {
  const localFolder = d.labels[DEVCONTAINER_LABEL.localFolder];
  if (localFolder === undefined || localFolder.trim() === "") return undefined;
  const configFile = d.labels[DEVCONTAINER_LABEL.configFile]?.trim() || null;
  return {
    id: d.id,
    name: d.name.replace(/^\//, ""),
    localFolder,
    configFile,
    state: d.state === "running" ? "running" : "stopped",
    workspaceFolder: workspaceFolderOf(localFolder, d.mounts),
    remoteUser: remoteUserOf(d),
    image: d.image,
    editorUri: editorUri(localFolder, configFile),
  };
}

/** The dev containers among these, by their folder's name, then the folder. */
export function devContainersOf(all: readonly ContainerDetails[]): DevContainer[] {
  return all
    .map(devContainerOf)
    .filter((c): c is DevContainer => c !== undefined)
    .sort(
      (a, b) =>
        lastPathPart(a.localFolder).localeCompare(lastPathPart(b.localFolder)) ||
        a.localFolder.localeCompare(b.localFolder) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * The container of a local folder: a running one before a stopped one (a rebuild can leave the old
 * one behind). An error the shell names `container-missing` when none carries the label.
 */
export function pickContainer(
  all: readonly DevContainer[],
  localFolder: string,
): Result<DevContainer, MetatorError> {
  const exact = all.filter((c) => sameFolder(c.localFolder, localFolder));
  // A person at a terminal may name it shorter: the folder's name, the container's name or id.
  const named = all.filter(
    (c) =>
      lastPathPart(c.localFolder) === localFolder ||
      c.name === localFolder ||
      (localFolder.length >= 6 && c.id.startsWith(localFolder)),
  );
  const folders = new Set(named.map((c) => hostPathKey(c.localFolder)));
  if (exact.length === 0 && folders.size > 1)
    return err(
      MetatorError.usage(
        `${localFolder} names the dev containers of ${folders.size} folders`,
        `Name one by its folder: ${[...new Set(named.map((c) => c.localFolder))].join(", ")}.`,
      ),
    );
  const mine = exact.length > 0 ? exact : named;
  const found = mine.find((c) => c.state === "running") ?? mine[0];
  if (found) return ok(found);
  return err(
    containerError(
      "container-missing",
      `no dev container of ${localFolder} was found`,
      "Open the folder once in VS Code (Reopen in Container), or run `devcontainer up`, then try again.",
    ),
  );
}

/** The Linux CLI bundle's architecture for what `uname -m` says; undefined for one without a bundle. */
export function bundleArch(machine: string): "x64" | "arm64" | undefined {
  const m = machine.trim().toLowerCase();
  if (m === "x86_64" || m === "amd64" || m === "x64") return "x64";
  if (m === "aarch64" || m === "arm64") return "arm64";
  return undefined;
}

/** The glibc dynamic loader of each architecture: without it the CLI cannot start. */
const GLIBC_LOADER: Readonly<Record<"x64" | "arm64", string>> = {
  x64: "/lib64/ld-linux-x86-64.so.2",
  arm64: "/lib/ld-linux-aarch64.so.1",
};

/** The marker of the probe's lines (a profile may print before them). */
const PROBE_MARK = "__metator_probe__";
/** The marker the login shell prints its PATH after. */
const PATH_MARK = "__METATOR_PATH__=";

/**
 * The probe, run once per command in the container as the remote user (`sh -c PROBE`): the machine,
 * the user, the home folder, the login shell's PATH (asked as VS Code asks it: a login interactive
 * shell, at most 5 s), glibc or musl, tar and gzip, and each installed version of the CLI with its
 * marker. Every line is `key=value` after a marker line.
 */
export const PROBE_SCRIPT = [
  `echo ${PROBE_MARK}`,
  'echo "machine=$(uname -m 2>/dev/null)"',
  "u=$(id -un 2>/dev/null || id -u)",
  'echo "user=$u"',
  'h="$HOME"',
  'if [ -z "$h" ] || [ "$h" = "/" ]; then h=$(getent passwd "$u" 2>/dev/null | cut -d: -f6); fi',
  'echo "home=$h"',
  's=$(getent passwd "$u" 2>/dev/null | cut -d: -f7); [ -x "$s" ] || s=/bin/sh',
  't=""; command -v timeout >/dev/null 2>&1 && t="timeout 5"',
  `p=$(HOME="$h" $t "$s" -lic 'printf "\\n${PATH_MARK}%s\\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^${PATH_MARK}//p' | tail -n 1)`,
  'echo "loginpath=$p"',
  'echo "path=$PATH"',
  'echo "glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed "s/^glibc //")"',
  `for l in ${GLIBC_LOADER.x64} ${GLIBC_LOADER.arm64}; do [ -e "$l" ] && echo "loader=$l"; done`,
  'for l in /lib/ld-musl-*.so.1; do [ -e "$l" ] && echo "musl=$l"; done',
  'command -v tar >/dev/null 2>&1 && echo "tar=yes"',
  'command -v gzip >/dev/null 2>&1 && echo "gzip=yes"',
  'for d in "$h"/.metator/server/*/; do [ -f "$d.installed" ] && echo "installed=$(basename "$d") $(cat "$d.installed")"; done',
].join("\n");

/** What the probe found. */
export interface ContainerProbe {
  /** `uname -m`. */
  readonly machine: string;
  readonly user: string;
  readonly home: string;
  /** The login shell's PATH; null when it did not say. */
  readonly loginPath: string | null;
  /** The PATH the exec had (the container's). */
  readonly path: string;
  /** `glibc` with its version, `musl`, or `unknown` (no loader of either). */
  readonly libc: "glibc" | "musl" | "unknown";
  readonly glibc: string | null;
  /** tar and gzip are there to unpack the bundle. */
  readonly tar: boolean;
  /** Each version of the CLI installed for this user, with its marker (the SHA-256 of the tarball it came from). */
  readonly installed: Readonly<Record<string, string>>;
}

/** The probe's lines, read; an error when the marker line is missing (the probe did not run). */
export function parseProbe(stdout: string): Result<ContainerProbe, MetatorError> {
  const lines = stdout.split(/\r?\n/);
  const start = lines.lastIndexOf(PROBE_MARK);
  if (start < 0)
    return err(
      new MetatorError(
        "COMMAND_FAILED",
        `the probe of the container answered nothing it could read: ${stdout.trim().slice(-300)}`,
      ),
    );
  const values = new Map<string, string[]>();
  for (const line of lines.slice(start + 1)) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    values.set(key, [...(values.get(key) ?? []), line.slice(at + 1).trim()]);
  }
  const one = (key: string): string => values.get(key)?.[0] ?? "";
  const glibc = one("glibc") || null;
  const loaders = values.get("loader") ?? [];
  const libc =
    glibc !== null || loaders.length > 0
      ? "glibc"
      : (values.get("musl") ?? []).length > 0
        ? "musl"
        : "unknown";
  return ok({
    machine: one("machine"),
    user: one("user"),
    home: one("home"),
    loginPath: one("loginpath") || null,
    path: one("path"),
    libc,
    glibc,
    tar: one("tar") === "yes" && one("gzip") === "yes",
    installed: Object.fromEntries(
      (values.get("installed") ?? [])
        .map((line) => line.split(/\s+/))
        .filter((parts) => parts.length === 2 && parts[0] !== "" && parts[1] !== "")
        .map(([version, sum]) => [version as string, sum as string]),
    ),
  });
}

/** `2.31` before `2.36`; a version that is not numbers counts as 0. */
export function compareGlibc(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The Linux CLI bundle the app carries for one architecture (its manifest, `kind: LinuxCliBundle`). */
export interface LinuxBundle {
  readonly version: string;
  readonly arch: "x64" | "arm64";
  /** The tarball on this computer, absolute. */
  readonly tarball: string;
  /** The launcher relative to where the tarball is unpacked. */
  readonly entry: string;
  readonly sha256: string;
  /** The oldest glibc it runs on. */
  readonly glibc: string;
}

/** The manifest's kind and the version this CLI reads (packages/cli/src/linux-bundle.ts writes it). */
export const LINUX_BUNDLE_KIND = "LinuxCliBundle";
export const LINUX_BUNDLE_VERSION = 1;

/**
 * A bundle manifest (already read as JSON) for `arch`; `tarballAt` turns its tarball's file name into
 * the path on this computer.
 */
export function linuxBundleOf(
  raw: unknown,
  arch: "x64" | "arm64",
  tarballAt: (name: string) => string,
): Result<LinuxBundle, MetatorError> {
  const m = (raw ?? {}) as Record<string, unknown>;
  const text = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : "");
  if (m.kind !== LINUX_BUNDLE_KIND)
    return err(
      new MetatorError(
        "INVALID_ARTIFACT",
        `the bundle manifest is not a ${LINUX_BUNDLE_KIND} (kind ${String(m.kind)})`,
      ),
    );
  if (m.schemaVersion !== LINUX_BUNDLE_VERSION)
    return err(
      new MetatorError(
        "INVALID_ARTIFACT",
        `the bundle manifest has schemaVersion ${String(m.schemaVersion)}; this CLI reads ${LINUX_BUNDLE_VERSION}`,
        {
          hint: "The app and its Linux CLI were built apart: reinstall the app.",
        },
      ),
    );
  if (text("arch") !== arch)
    return err(
      new MetatorError(
        "INVALID_ARTIFACT",
        `the bundle in the folder of ${arch} is for ${text("arch") || "no architecture"}`,
      ),
    );
  const missing = ["version", "tarball", "entry", "sha256", "glibc"].filter((k) => text(k) === "");
  if (missing.length > 0)
    return err(new MetatorError("INVALID_ARTIFACT", `the bundle manifest lacks ${missing.join(", ")}`));
  return ok({
    version: text("version"),
    arch,
    tarball: tarballAt(text("tarball")),
    entry: text("entry"),
    sha256: text("sha256"),
    glibc: text("glibc"),
  });
}

/** Makes the folder of the CLI's versions, writable by its user only (`sh -c MKDIR sh <dir>`). */
export const MKDIR_SCRIPT = 'umask 022 && mkdir -p "$1"';

/** Where a version of the CLI lives in the container: per user, never on the person's PATH. */
export const serverDir = (home: string, version: string): string =>
  `${home.replace(/\/+$/, "")}/.metator/server/${version}`;

/** The launcher of an installed bundle. */
export const launcherIn = (home: string, bundle: Pick<LinuxBundle, "version" | "entry">): string =>
  `${serverDir(home, bundle.version)}/${bundle.entry}`;

/**
 * Whether the bundle must be copied in (the version check, ADR-0106): not when the marker of its
 * version holds its SHA-256. A container the bundle cannot run in is an error first: an architecture
 * without a bundle, musl (Alpine), a glibc older than the bundle's, no tar or gzip to unpack it.
 */
export function installNeeded(probe: ContainerProbe, bundle: LinuxBundle): Result<boolean, MetatorError> {
  if (bundleArch(probe.machine) !== bundle.arch)
    return err(
      containerError(
        "unsupported",
        `the container's machine is ${probe.machine || "unknown"}; MetatorAI's Linux CLI is for x86_64 and aarch64`,
      ),
    );
  if (probe.libc === "musl")
    return err(
      containerError(
        "musl",
        "this container is Alpine-based (musl); MetatorAI's Linux CLI needs glibc",
        "Use a Debian or Ubuntu based image for the dev container (mcr.microsoft.com/devcontainers/base:bookworm, for one).",
      ),
    );
  if (probe.libc === "unknown")
    return err(
      containerError("unsupported", "no glibc was found in the container; MetatorAI's Linux CLI needs it"),
    );
  if (probe.glibc !== null && compareGlibc(probe.glibc, bundle.glibc) < 0)
    return err(
      containerError(
        "unsupported",
        `the container has glibc ${probe.glibc}; MetatorAI's Linux CLI needs ${bundle.glibc} or newer`,
        "Use a newer image (Debian 11, Ubuntu 20.04 or later).",
      ),
    );
  if (probe.installed[bundle.version] === bundle.sha256) return ok(false);
  if (!probe.tar)
    return err(
      containerError(
        "unsupported",
        "the container has no tar or gzip to unpack MetatorAI's CLI",
        "Install them in the image (apt-get install -y tar gzip), as VS Code needs them too.",
      ),
    );
  return ok(true);
}

/**
 * Unpacks the copied tarball into the version's folder, as the remote user (`sh -c INSTALL sh <dir>
 * <tarball> <sha256>`): its SHA-256 checked when `sha256sum` is there, unpacked beside the folder
 * and moved into place, the marker written last, the tarball removed. Nobody else may write there
 * (umask 022, whatever the engine's exec has). A half-done install leaves
 * no marker, so the next one starts again.
 */
export const INSTALL_SCRIPT = [
  "set -e",
  "umask 022",
  'dir="$1"; tarball="$2"; sum="$3"',
  "if command -v sha256sum >/dev/null 2>&1; then",
  '  got=$(sha256sum "$tarball" | cut -d" " -f1)',
  '  if [ "$got" != "$sum" ]; then rm -f "$tarball"; echo "metator: the copy of the CLI is damaged (sha256 $got, expected $sum)" >&2; exit 3; fi',
  "fi",
  'tmp="$dir.partial.$$"',
  'rm -rf "$tmp"; mkdir -p "$tmp"',
  'tar -xzf "$tarball" -C "$tmp"',
  'rm -rf "$dir"; mv "$tmp" "$dir"',
  'printf "%s\\n" "$sum" > "$dir/.installed"',
  'rm -f "$tarball"',
].join("\n");

/**
 * The environment of every process the app starts in the container: the user's home and login
 * PATH (as a terminal of the container has them), the devcontainer's `remoteEnv` over them, and
 * a sign that MetatorAI runs in a dev container (`inspect` then says how to add a missing tool there).
 */
export function execEnv(
  probe: ContainerProbe,
  d: Pick<ContainerDetails, "metadata" | "env">,
): Record<string, string> {
  const remote = remoteEnvOf(d);
  return {
    HOME: probe.home,
    ...(probe.user && !/^\d+$/.test(probe.user) ? { USER: probe.user, LOGNAME: probe.user } : {}),
    PATH: probe.loginPath ?? probe.path,
    ...remote,
    [IN_DEVCONTAINER_ENV]: "1",
  };
}

/** Set in every process the app starts in a dev container. */
export const IN_DEVCONTAINER_ENV = "METATOR_IN_DEVCONTAINER";

/**
 * The command the app's forwarder starts for each connection: the engine runs `metator tunnel` in the
 * container, which joins its stdin and stdout to the daemon's port there (ADR-0106).
 */
export function tunnelArgv(
  engine: Pick<ContainerEngineInfo, "path">,
  container: Pick<DevContainer, "id" | "remoteUser">,
  launcher: string,
  port: number,
): string[] {
  return [
    engine.path,
    "exec",
    "-i",
    "-u",
    container.remoteUser,
    container.id,
    launcher,
    "tunnel",
    "--port",
    String(port),
  ];
}

/**
 * How to add a missing tool to a dev container: a feature for `devcontainer.json` (the container is
 * rebuilt with it) and a command for the container's terminal.
 */
export interface ContainerFix {
  readonly feature?: string;
  readonly command?: string;
}

export const GIT_CONTAINER_FIX: ContainerFix = {
  feature: '"ghcr.io/devcontainers/features/git:1": {}',
  command: "sudo apt-get update && sudo apt-get install -y git",
};
