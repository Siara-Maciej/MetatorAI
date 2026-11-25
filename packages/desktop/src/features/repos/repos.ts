/**
 * The repositories of the app (round 20, ADR-0105), pure: what an inspection of a folder means in
 * plain words and what the person can do next, the Add repository flow as a state machine, the
 * repository switcher's rows, and the commands the web build shows instead of running them. The
 * screens (`screens/add-repo.tsx`, `screens/first-run.tsx`, `components/repo-switcher.tsx`) draw
 * what these say.
 */
import { plural } from "../../shared/model/format.ts";
import type {
  CliInfo,
  HostFix,
  HostId,
  Inspection,
  KnownRepo,
} from "../../shared/platform/tauri-commands.ts";

/** A tool MetatorAI needs and cannot install, with where to get it. */
export interface Requirement {
  readonly id: string;
  readonly name: string;
  readonly ok: boolean;
  /** What is wrong, in a few words; empty when it is ok. */
  readonly problem: string;
  /** Where to get it; empty when what is missing is a login. */
  readonly link: string;
  /** In a dev container (round 21): how to add it there, when it is missing. */
  readonly fix?: HostFix | undefined;
}

export const GIT_DOWNLOAD = "https://git-scm.com/downloads";

const HOST_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  copilot: "GitHub Copilot CLI",
};

/** A host's name as a person knows it. */
export const hostName = (id: string): string => HOST_NAMES[id] ?? id;

/**
 * What MetatorAI needs on this computer: git, and one AI host installed and logged in. With no
 * host installed, each host is a missing tool with its own link (one is enough); with one or
 * more, only the installed ones are listed, a missing login as what to type.
 */
export function requirements(i: Pick<Inspection, "git" | "hosts">): Requirement[] {
  const git: Requirement = {
    id: "git",
    name: "git",
    ok: i.git.installed,
    problem: i.git.installed ? "" : "not installed",
    link: i.git.install?.url ?? GIT_DOWNLOAD,
    ...(!i.git.installed && i.git.fix ? { fix: i.git.fix } : {}),
  };
  const installed = i.hosts.filter((h) => h.installed);
  const shown = installed.length > 0 ? installed : i.hosts;
  return [
    git,
    ...shown.map((h) => ({
      id: h.id,
      name: hostName(h.id),
      ok: h.installed && h.loggedIn !== false,
      problem: !h.installed ? "not installed" : h.loggedIn === false ? `not logged in: run ${h.login}` : "",
      link: h.installed ? "" : h.install.url,
      // A login is typed, not installed: the fix is for a missing program only.
      ...(!h.installed && h.fix ? { fix: h.fix } : {}),
    })),
  ];
}

/** git and one host installed and logged in: nothing stops MetatorAI from working. */
export const ready = (rs: readonly Requirement[]): boolean =>
  rs.find((r) => r.id === "git")?.ok === true && rs.some((r) => r.id !== "git" && r.ok);

/** A host the person can choose for setup: only an installed one can be chosen. */
export interface HostChoice {
  readonly id: HostId;
  readonly name: string;
  readonly enabled: boolean;
  /** Why it cannot be chosen, or what to know about it. */
  readonly note: string;
}

/** The hosts in `supervisor.hostOrder` (the inspection's order). */
export function hostChoices(i: Pick<Inspection, "hosts">): HostChoice[] {
  return i.hosts.map((h) => ({
    id: h.id,
    name: hostName(h.id),
    enabled: h.installed,
    note: !h.installed ? "not installed" : h.loggedIn === false ? `not logged in: run ${h.login}` : "",
  }));
}

/** The default host: the inspection's (the first installed in `supervisor.hostOrder`), when it can be chosen. */
export const defaultHost = (i: Pick<Inspection, "hosts" | "defaultHost">): HostId | undefined =>
  hostChoices(i).find((h) => h.enabled && h.id === i.defaultHost)?.id ??
  hostChoices(i).find((h) => h.enabled)?.id;

/** What a folder is, as the next screen treats it. */
export type FolderKind =
  | "missing"
  | "no-git"
  | "too-new"
  | "folder"
  | "not-repo"
  | "set-up"
  | "no-host"
  | "not-set-up";

/** What the inspection found, in plain words, and the one thing to do next. */
export interface Reading {
  readonly kind: FolderKind;
  readonly title: string;
  readonly lines: readonly string[];
  /** The primary button's words; none when the person must fix something outside the app first. */
  readonly action: string | undefined;
}

/** The repository a folder belongs to (a worktree's main checkout); the folder itself when none. */
export const repoPathOf = (i: Pick<Inspection, "path" | "repository">): string =>
  i.repository?.root ?? i.path;

/** The files setup writes for this host. */
export const writesFor = (i: Pick<Inspection, "writes">, host: HostId | undefined): readonly string[] =>
  (host ? i.writes[host] : undefined) ?? [];

/** Where the folder is: on this computer, or in a dev container (round 21). */
export type Where = "here" | "container";

/** The words that change when the folder is in a dev container. */
const WORDS = {
  here: {
    missing: "There is no folder here",
    noGit: "git is not installed",
    installIt: "Install it, then press Retry.",
    installOne: "Install one, then press Retry.",
    setUp: "MetatorAI is already set up here",
    noHost: "No AI host is installed",
    notSetUp: "MetatorAI is not set up here yet",
    notRepo: "This folder is not a git repository",
  },
  container: {
    missing: "There is no such folder in the container",
    noGit: "git is not installed in the container",
    installIt: "Add it to the container as said below, then press Retry.",
    installOne: "Add one to the container as said below, then press Retry.",
    setUp: "MetatorAI is already set up in the container",
    noHost: "No AI host is installed in the container",
    notSetUp: "MetatorAI is not set up in the container yet",
    notRepo: "This folder in the container is not a git repository",
  },
} as const;

/** The inspection's `next`, in words: the CLI decides what the folder is, the app says it. */
export function readInspection(
  i: Inspection,
  host: HostId | undefined = defaultHost(i),
  where: Where = "here",
): Reading {
  const w = WORDS[where];
  if (i.kind === "missing" || i.next === "choose-another")
    return { kind: "missing", title: w.missing, lines: [i.path], action: undefined };
  if (!i.git.installed)
    return {
      kind: "no-git",
      title: w.noGit,
      lines: [`MetatorAI keeps its work in git. ${w.installIt}`],
      action: undefined,
    };
  if (i.next === "update-app")
    return {
      kind: "too-new",
      title: "A newer MetatorAI set this up",
      lines: [
        `This app (${i.version}) cannot read its settings. Update the app to open it; nothing was changed.`,
      ],
      action: undefined,
    };
  if (i.kind === "folder") {
    const repos = i.folder?.repos ?? [];
    const todo = repos.filter((r) => r.setUp === "no").length;
    return {
      kind: "folder",
      title: `A folder of ${plural(repos.length, "repository", "repositories")}`,
      lines: [
        todo === 0
          ? "Every one is set up."
          : `${todo} of them ${todo === 1 ? "is" : "are"} not set up yet. Set up the ones you want, then add the folder.`,
      ],
      action: "Add the folder",
    };
  }
  if (i.kind === "not-git" || !i.repository)
    return {
      kind: "not-repo",
      title: w.notRepo,
      lines: ["MetatorAI works in a git repository. git init makes this folder one; nothing else changes."],
      action: "Make it a git repository",
    };
  const r = i.repository;
  const within = [
    // What it is, in one line: "Java · Maven, 14 modules" (round 22).
    ...(r.stack?.line ? [r.stack.line] : []),
    ...(r.worktree
      ? [`A worktree of ${r.root}: the app adds that repository.`]
      : r.root !== i.path
        ? [`Inside the repository ${r.root}: the app adds that.`]
        : []),
  ];
  if (i.next === "add")
    return {
      kind: "set-up",
      title: w.setUp,
      lines: [...within, "Nothing needs to be written. Add it and open it."],
      action: "Add and open",
    };
  if (host === undefined)
    return {
      kind: "no-host",
      title: w.noHost,
      lines: [...within, `Setup needs Claude Code or GitHub Copilot CLI. ${w.installOne}`],
      action: undefined,
    };
  const dirty =
    r.uncommitted.length > 0
      ? [`It has ${plural(r.uncommitted.length, "uncommitted change")}. Setup leaves them as they are.`]
      : [];
  return {
    kind: "not-set-up",
    title: w.notSetUp,
    lines: [
      ...within,
      `Setup will write ${plural(writesFor(i, host).length, "file")}. Nothing is committed unless you say so.`,
      ...dirty,
    ],
    action: "Set up",
  };
}

/** The steps of Add repository. A busy step (…ing) has no buttons; an error stays on the step it returns to. */
export type Flow =
  | { readonly step: "pick"; readonly path: string; readonly error?: string | undefined }
  | { readonly step: "inspecting"; readonly path: string }
  | {
      readonly step: "inspected";
      readonly inspection: Inspection;
      readonly host: HostId | undefined;
      /** The output of a setup that failed, kept for "Show output". */
      readonly lines?: readonly string[] | undefined;
      readonly error?: string | undefined;
    }
  | { readonly step: "initializing"; readonly inspection: Inspection; readonly host: HostId | undefined }
  | {
      readonly step: "setting-up";
      readonly inspection: Inspection;
      /** The repository being set up: the folder's child, or the repository itself. */
      readonly target: string;
      readonly host: HostId;
      readonly lines: readonly string[];
    }
  | {
      readonly step: "set-up";
      readonly inspection: Inspection;
      readonly target: string;
      readonly host: HostId;
      readonly written: readonly string[];
      readonly lines: readonly string[];
      readonly error?: string | undefined;
    }
  | {
      readonly step: "committing";
      readonly inspection: Inspection;
      readonly target: string;
      readonly host: HostId;
      readonly written: readonly string[];
      readonly lines: readonly string[];
    }
  | {
      readonly step: "ready";
      readonly path: string;
      /** What the last setup did: committed as this, or left for the person to commit. */
      readonly commit?: string | undefined;
      readonly uncommitted?: number | undefined;
      readonly error?: string | undefined;
    }
  | { readonly step: "opening"; readonly path: string }
  | { readonly step: "open"; readonly path: string };

export type FlowEvent =
  | { readonly type: "type"; readonly path: string }
  | { readonly type: "inspect"; readonly path: string }
  | { readonly type: "inspected"; readonly inspection: Inspection }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "host"; readonly host: HostId }
  | { readonly type: "git-init" }
  | { readonly type: "setup"; readonly target?: string | undefined }
  | { readonly type: "line"; readonly line: string }
  | { readonly type: "setup-done"; readonly written: readonly string[] }
  | { readonly type: "commit" }
  | { readonly type: "committed"; readonly commit: string }
  | { readonly type: "not-now" }
  | { readonly type: "open" }
  | { readonly type: "opened" }
  | { readonly type: "back" };

export const START: Flow = { step: "pick", path: "" };

/** What comes after the commit card: the folder is inspected again, a repository is ready to open. */
function afterCommit(
  s: { readonly inspection: Inspection; readonly target: string },
  commit: string | undefined,
  uncommitted: number | undefined,
): Flow {
  if (s.inspection.folder) return { step: "inspecting", path: s.inspection.path };
  return {
    step: "ready",
    path: s.target,
    ...(commit ? { commit } : {}),
    ...(uncommitted ? { uncommitted } : {}),
  };
}

/** The flow's one transition function: an event that does not fit the step changes nothing. */
export function flowStep(s: Flow, e: FlowEvent): Flow {
  switch (e.type) {
    case "type":
      return s.step === "pick" ? { step: "pick", path: e.path } : s;
    case "inspect": {
      const path = e.path.trim();
      if (path === "") return s;
      const resting = s.step === "pick" || s.step === "inspected" || s.step === "ready";
      return resting ? { step: "inspecting", path } : s;
    }
    case "inspected":
      return s.step === "inspecting" || s.step === "initializing"
        ? { step: "inspected", inspection: e.inspection, host: defaultHost(e.inspection) }
        : s;
    case "failed":
      switch (s.step) {
        case "inspecting":
          return { step: "pick", path: s.path, error: e.error };
        case "initializing":
          return { step: "inspected", inspection: s.inspection, host: s.host, error: e.error };
        case "setting-up":
          return {
            step: "inspected",
            inspection: s.inspection,
            host: s.host,
            lines: s.lines,
            error: e.error,
          };
        case "committing":
          return { ...s, step: "set-up", error: e.error };
        case "opening":
          return { step: "ready", path: s.path, error: e.error };
        default:
          return s;
      }
    case "host": {
      if (s.step !== "inspected") return s;
      const choice = hostChoices(s.inspection).find((h) => h.id === e.host);
      return choice?.enabled ? { ...s, host: e.host } : s;
    }
    case "git-init":
      return s.step === "inspected" && readInspection(s.inspection, s.host).kind === "not-repo"
        ? { step: "initializing", inspection: s.inspection, host: s.host }
        : s;
    case "setup": {
      if (s.step !== "inspected" || s.host === undefined) return s;
      const kind = readInspection(s.inspection, s.host).kind;
      const child = s.inspection.folder?.repos.find((r) => r.root === e.target);
      const target =
        kind === "folder"
          ? child?.setUp === "no"
            ? child.root
            : undefined
          : kind === "not-set-up"
            ? repoPathOf(s.inspection)
            : undefined;
      return target === undefined
        ? s
        : { step: "setting-up", inspection: s.inspection, target, host: s.host, lines: [] };
    }
    case "line":
      return s.step === "setting-up" ? { ...s, lines: [...s.lines, e.line] } : s;
    case "setup-done":
      if (s.step !== "setting-up") return s;
      // Nothing written: there is nothing to commit, and no card asks.
      return e.written.length === 0
        ? afterCommit(s, undefined, undefined)
        : { ...s, step: "set-up", written: e.written };
    case "commit":
      return s.step === "set-up" ? { ...s, step: "committing" } : s;
    case "committed":
      return s.step === "committing" ? afterCommit(s, e.commit, undefined) : s;
    case "not-now":
      return s.step === "set-up" ? afterCommit(s, undefined, s.written.length) : s;
    case "open": {
      if (s.step === "ready") return { step: "opening", path: s.path };
      if (s.step !== "inspected") return s;
      const kind = readInspection(s.inspection, s.host).kind;
      if (kind === "set-up") return { step: "opening", path: repoPathOf(s.inspection) };
      return kind === "folder" ? { step: "opening", path: s.inspection.path } : s;
    }
    case "opened":
      return s.step === "opening" ? { step: "open", path: s.path } : s;
    case "back":
      return s.step === "inspected" || s.step === "ready" ? { step: "pick", path: pathOf(s) } : s;
  }
}

/** The folder a step is about. */
export function pathOf(s: Flow): string {
  switch (s.step) {
    case "inspected":
    case "initializing":
      return s.inspection.path;
    case "setting-up":
    case "set-up":
    case "committing":
      return s.target;
    default:
      return s.path;
  }
}

/** The one progress line of a running setup (or install): its last line with words, else that it started. */
export function progressLine(lines: readonly string[], empty = "Starting setup…"): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line !== "") return line;
  }
  return empty;
}

/** The commit card's question. */
export const commitQuestion = (written: readonly string[]): string =>
  `Setup wrote ${plural(written.length, "file")}. Commit them?`;

/**
 * A dev container's state as the app last saw it (round 21): running, stopped, or "missing" (no
 * container carries its local folder label any more). Unknown until the engine was asked.
 */
export type ContainerState = "running" | "stopped" | "missing";

/** The local folder label of each dev container the engine listed, with its state. */
export type ContainerStates = Readonly<Record<string, "running" | "stopped">>;

/** A known dev container's state: what the engine listed, "missing" when it listed others but not it. */
export function containerStateOf(
  k: Pick<KnownRepo, "devcontainer">,
  states: ContainerStates | undefined,
): ContainerState | undefined {
  if (!k.devcontainer || !states) return undefined;
  return states[k.devcontainer.localFolder] ?? "missing";
}

/** The name a repository goes by in the app: a dev container's says so ("shop (Dev Container)"). */
export const repoName = (k: Pick<KnownRepo, "name" | "kind">): string =>
  k.kind === "devcontainer" ? `${k.name} (Dev Container)` : k.name;

/** One row of the repository switcher. */
export interface SwitcherRow {
  readonly path: string;
  /** "shop", or "shop (Dev Container)". */
  readonly name: string;
  readonly kind: KnownRepo["kind"];
  readonly current: boolean;
  /** A dim word: "folder" for a folder of repositories, a dev container's state when it is not running. */
  readonly note: string;
  /** A dev container's state; undefined for a folder on this computer, or before the engine answered. */
  readonly state: ContainerState | undefined;
}

const STATE_NOTE: Readonly<Record<ContainerState, string>> = {
  running: "running",
  stopped: "stopped",
  missing: "container not found",
};

/** The repositories and folders the app knows, by name, the current one marked. */
export function switcherRows(
  known: readonly KnownRepo[],
  current: string | undefined,
  states?: ContainerStates,
): SwitcherRow[] {
  return [...known]
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    .map((k) => {
      const state = containerStateOf(k, states);
      return {
        path: k.path,
        name: repoName(k),
        kind: k.kind,
        current: k.path === current,
        note: k.kind === "folder" ? "folder" : state ? STATE_NOTE[state] : "",
        state,
      };
    });
}

/** The repository the app opens: the remembered one when the app still knows it, else the first added. */
export function currentRepo(
  known: readonly KnownRepo[],
  remembered: string | undefined,
): KnownRepo | undefined {
  return known.find((k) => k.path === remembered) ?? known[0];
}

/** After "Remove from the app": the one to open instead, when the removed one was open; none left is the first run. */
export function afterRemove(
  known: readonly KnownRepo[],
  removed: string,
  current: string | undefined,
): { readonly open: KnownRepo | undefined; readonly stay: boolean } {
  if (removed !== current) return { open: undefined, stay: true };
  return { open: known.find((k) => k.path !== removed), stay: false };
}

/** The top bar's words: the open repository's name, and how many repositories its daemon serves when more than one. */
export function switcherLabel(current: KnownRepo | undefined, served: string): string {
  if (!current) return served;
  return current.kind === "folder" ? `${current.name} · ${served}` : repoName(current);
}

/** What the app shows instead of the daemon's screens. */
export type ShellView = "first-run" | "add" | "app-settings" | "no-daemon" | "container-down" | "screens";

export function shellView(a: {
  /** The app has its shell's commands (the Tauri window, or the e2e's fake). */
  readonly commands: boolean;
  /** The repositories the app knows; undefined while they are read. */
  readonly known: readonly KnownRepo[] | undefined;
  readonly down: boolean;
  readonly screen: string;
  /** The repository the app has open (round 21: a dev container's has its own panel). */
  readonly current?: Pick<KnownRepo, "kind"> | undefined;
  /** The last start of its daemon failed, and none is starting. */
  readonly startFailed?: boolean | undefined;
}): ShellView {
  if (a.screen === "add") return "add";
  if (a.screen === "app") return "app-settings";
  if (a.commands && a.known !== undefined && a.known.length === 0) return "first-run";
  // A dev container that stopped (or its link that dropped): Start and Reconnect, not the daemon's panel.
  if (a.current?.kind === "devcontainer" && (a.down || a.startFailed === true)) return "container-down";
  return a.down ? "no-daemon" : "screens";
}

/** A path as a shell reads it: quoted when it has anything but plain characters. */
export const shellPath = (path: string): string =>
  /^[\w@%+=:,./~-]+$/.test(path) ? path : `"${path.replace(/(["\\$`])/g, "\\$1")}"`;

/**
 * The web build cannot run anything: the commands the desktop app would run, in order, for a
 * person to type in a terminal.
 */
export function webCommands(path: string, host: string): string[] {
  const where = path.trim() === "" ? "/path/to/your/repository" : path.trim();
  return [
    `cd ${shellPath(where)}`,
    "metator inspect .",
    `metator setup --host ${host} --yes`,
    "metator setup --commit --files <the files setup listed>",
    "metator serve",
  ];
}

/** Where the `metator` command comes from, in words. */
export function cliSourceText(info: Pick<CliInfo, "source">): string {
  switch (info.source) {
    case "bundled":
      return "Bundled with the app";
    case "path":
      return "The metator on your PATH";
    case "custom":
      return "A metator you chose";
  }
}

/**
 * The known repository or folder an inspection is about: it is opened, never set up again. In a
 * dev container (its local folder label), the known entry of that container.
 */
export function alreadyAdded(
  known: readonly KnownRepo[] | undefined,
  i: Inspection,
  container?: string,
): KnownRepo | undefined {
  if (container !== undefined) return known?.find((k) => k.devcontainer?.localFolder === container);
  const path = i.folder ? i.path : repoPathOf(i);
  return known?.find((k) => k.kind !== "devcontainer" && k.path === path);
}

/** Where the desktop app comes from, for the web build's Add repository. */
export const DESKTOP_DOWNLOAD = "https://github.com/Siara-Maciej/MetatorAI/releases/tag/desktop-latest";

/** A commit as a person reads it: its first seven characters. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** What "Install the metator command" did: where it wrote, and what is left when its folder is not on the PATH. */
export function installedText(r: { readonly path: string; readonly onPath: boolean }): string {
  if (r.onPath) return `Wrote ${r.path}. A new terminal finds metator.`;
  const dir = r.path.replace(/[\\/][^\\/]*$/, "");
  return `Wrote ${r.path}. Its folder is not on your PATH yet: add ${dir} to it, then open a new terminal.`;
}
