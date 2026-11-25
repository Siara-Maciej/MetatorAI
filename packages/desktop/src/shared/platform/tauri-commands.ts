/**
 * The commands of the app's shell (round 20, ADR-0105): what the Tauri window does that a browser
 * tab cannot (pick a folder, inspect it, set it up, commit what setup wrote, remember it, start
 * its daemon). One typed wrapper over Tauri's `invoke`; `fakeCommands` (fake-commands.ts) is the
 * same interface for the tests and the e2e. In a browser there are none (`appCommands` is
 * undefined) and the app shows the commands to run instead.
 */

/**
 * How a command refuses (`ShellError`): the CLI's error code or the shell's (NO_CLI, SPAWN, IO,
 * NEWER_FILE; round 21: NO_ENGINE, CONTAINER_MISSING, CONTAINER_STOPPED, MUSL, UNSUPPORTED).
 */
export interface CommandError {
  readonly code: string;
  readonly message: string;
  readonly hint?: string | undefined;
}

export type HostId = "copilot" | "claude";

/** An AI host MetatorAI knows, as the inspection found it on this computer. */
export interface InspectedHost {
  readonly id: HostId;
  /** The program on PATH: "copilot", "claude". */
  readonly program: string;
  readonly installed: boolean;
  /** A login was found (true), installed with no sign of one (false), not installed (null). */
  readonly loggedIn: boolean | null;
  /** How to install it: a page to open and a command to copy. */
  readonly install: { readonly url: string; readonly command: string };
  /** How to log in, as a person types it ("claude, then /login"). */
  readonly login: string;
  /** In a dev container (round 21): how to add it there, as the engine words it. */
  readonly fix?: HostFix | undefined;
}

/**
 * How to add a missing tool to a dev container (round 21): a feature line for `devcontainer.json`
 * (the container is rebuilt with it), or a command for the container's terminal.
 */
export interface HostFix {
  readonly feature?: string | undefined;
  readonly command?: string | undefined;
}

/** A repository the inspection found: the one looked at, or one of a folder's. */
export interface InspectedRepository {
  /** Its main checkout, absolute: what the app adds and opens. */
  readonly root: string;
  readonly name: string;
  /** The path inspected was a linked worktree of `root`. */
  readonly worktree: boolean;
  /** "newer": its config was written by a newer MetatorAI than this one (never downgraded). */
  readonly setUp: "yes" | "no" | "newer";
  readonly config: string | null;
  /** Files with uncommitted changes, sorted. */
  readonly uncommitted: readonly string[];
  /** The languages and builds at its root, and all of it in one line ("Java · Maven, 14 modules"). */
  readonly stack?:
    | {
        readonly languages: readonly string[];
        readonly builds: readonly {
          readonly tool: string;
          readonly wrapper: boolean;
          readonly modules: number;
          readonly label: string;
        }[];
        readonly line: string;
      }
    | undefined;
}

/** What `metator inspect <path> --json` found (Agent A's shape, passed through; deterministic, read-only). */
export interface Inspection {
  /** The folder looked at, absolute and normalized. */
  readonly path: string;
  readonly kind: "missing" | "not-git" | "repo" | "folder";
  /** What the app offers next. */
  readonly next:
    | "choose-another"
    | "install-git"
    | "git-init"
    | "setup"
    | "add"
    | "setup-repos"
    | "update-app";
  readonly git: {
    readonly installed: boolean;
    readonly version: string | null;
    /** Where git comes from: the app cannot install it. */
    readonly install?: { readonly url: string } | undefined;
    /** In a dev container: how to add it there. */
    readonly fix?: HostFix | undefined;
  };
  /** kind "repo": the repository. */
  readonly repository: InspectedRepository | null;
  /** kind "folder": its repositories. */
  readonly folder: { readonly file: string | null; readonly repos: readonly InspectedRepository[] } | null;
  /** Every host MetatorAI knows, in `supervisor.hostOrder`. */
  readonly hosts: readonly InspectedHost[];
  /** The first installed host in that order; null when none is installed. */
  readonly defaultHost: HostId | null;
  /** What `setup --host <h>` writes in a repository not set up yet, per host, sorted. */
  readonly writes: Readonly<Partial<Record<HostId, readonly string[]>>>;
  /** This CLI's version (the app's: they ship together). */
  readonly version: string;
}

export interface KnownRepo {
  /** Its key: a folder's absolute path; a dev container's is "devcontainer:" + its local folder label (opaque). */
  readonly path: string;
  readonly name: string;
  readonly kind: "repo" | "folder" | "devcontainer";
  readonly addedAt: string;
  /** kind "devcontainer" (round 21): the container, known by its local folder label. */
  readonly devcontainer?: KnownDevContainer | undefined;
}

/** A repository in a dev container, as the app remembers it: stable across rebuilds of the container. */
interface KnownDevContainer {
  /** The `devcontainer.local_folder` label: the container's identity. */
  readonly localFolder: string;
  /** The repository inside the container (absolute there). */
  readonly workspaceFolder: string;
  readonly configFile: string | null;
  /** The engine's editor link for the container ("vscode://vscode-remote/dev-container+<hex>"). */
  readonly editorUri: string;
}

/** The container CLI the app found on this computer (round 21). */
export interface ContainerEngine {
  readonly program: "docker" | "nerdctl";
  /** docker's current context ("rancher-desktop", "desktop-linux"); null for nerdctl or none. */
  readonly context: string | null;
  readonly version: string;
}

/** A dev container the engine lists (labelled `devcontainer.local_folder`). */
export interface DevContainer {
  /** The container's id now: looked up again on each connect. */
  readonly id: string;
  readonly name: string;
  /** The `devcontainer.local_folder` label: its identity. */
  readonly localFolder: string;
  readonly configFile: string | null;
  readonly state: "running" | "stopped";
  /** The workspace folder inside it; null when the engine found none. */
  readonly workspaceFolder: string | null;
  /** The user every process runs as there (remoteUser, containerUser, the image's, else root). */
  readonly remoteUser: string;
  readonly image: string;
  /** VS Code on this computer attached to it: "vscode://vscode-remote/dev-container+<hex>". */
  readonly editorUri: string;
}

export interface DevContainerList {
  /** null: neither docker nor nerdctl answered. */
  readonly engine: ContainerEngine | null;
  readonly containers: readonly DevContainer[];
  /** With engine null: why, in a sentence; else null. */
  readonly problem: string | null;
}

interface InstallOutput {
  readonly runId: string;
  readonly line: string;
}

export interface InstallDone {
  readonly runId: string;
  readonly ok: boolean;
  /** The version installed (or found there already). */
  readonly version?: string | undefined;
  /** Where in the container. */
  readonly path?: string | undefined;
  readonly error?: CommandError | undefined;
}

export type InstallEvent =
  | ({ readonly kind: "output" } & InstallOutput)
  | ({ readonly kind: "done" } & InstallDone);

export type CliSource = "bundled" | "path" | "custom";

export interface CliInfo {
  readonly source: CliSource;
  /** The program the app runs. */
  readonly path: string;
  /** Its `metator version`; "" when it could not say. */
  readonly version: string;
}

interface SetupOutput {
  readonly runId: string;
  readonly line: string;
}

export interface SetupDone {
  readonly runId: string;
  readonly ok: boolean;
  /** Repository-relative paths setup wrote, sorted: what `commit_setup` takes. */
  readonly written: readonly string[];
  readonly error?: CommandError | undefined;
}

/**
 * The shell's commands, one method each (the contract's list). `container` (round 21) is a dev
 * container's local folder label: the command runs in that container, and `path` is a path there.
 */
export interface Commands {
  pickFolder(): Promise<string | null>;
  inspectFolder(path: string, container?: string): Promise<Inspection>;
  runSetup(path: string, host: HostId, container?: string): Promise<{ readonly runId: string }>;
  /** Listens to `setup://output` and `setup://done`; resolves to the function that stops listening. */
  onSetup(listener: (e: SetupEvent) => void): Promise<() => void>;
  gitInit(path: string, container?: string): Promise<void>;
  /** Stages exactly these files and commits "Set up MetatorAI"; answers the full sha. */
  commitSetup(
    path: string,
    files: readonly string[],
    container?: string,
  ): Promise<{ readonly commit: string; readonly files?: readonly string[] | undefined }>;
  /** In the order added. */
  knownRepos(): Promise<readonly KnownRepo[]>;
  /** Adding one already there returns it unchanged. With `container`, a dev container's repository. */
  addRepo(path: string, container?: string): Promise<KnownRepo>;
  /** Forgets it; never deletes files. */
  removeRepo(path: string): Promise<void>;
  openRepo(path: string): Promise<{ readonly url: string }>;
  cliInfo(): Promise<CliInfo>;
  setCliSource(source: CliSource, path?: string): Promise<CliInfo>;
  /** onPath false: the folder it wrote in is not on the PATH yet. */
  installCliCommand(): Promise<{ readonly path: string; readonly onPath: boolean }>;
  /** The launcher removed; null when there was none. */
  uninstallCliCommand(): Promise<{ readonly path: string | null }>;
  /** The dev containers the engine lists (round 21); `engine` null when there is none. */
  listDevContainers(): Promise<DevContainerList>;
  /** Starts a stopped dev container; answers it running. */
  startDevContainer(localFolder: string): Promise<DevContainer>;
  /** Copies the Linux CLI into the container when it is not there in this version; returns at once. */
  installInContainer(localFolder: string): Promise<{ readonly runId: string }>;
  /** Listens to `container://install-output` and `container://install-done`. */
  onInstall(listener: (e: InstallEvent) => void): Promise<() => void>;
  /** Opens a link on this computer (the editor's vscode-remote link). */
  openUri(uri: string): Promise<void>;
}

export type SetupEvent =
  | ({ readonly kind: "output" } & SetupOutput)
  | ({ readonly kind: "done" } & SetupDone);

/** Whatever a command rejected with, as `{ code, message, hint }`. */
export function asCommandError(e: unknown): CommandError {
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") {
    const o = e as { code?: unknown; message: string; hint?: unknown };
    return {
      code: typeof o.code === "string" ? o.code : "FAILED",
      message: o.message,
      ...(typeof o.hint === "string" && o.hint !== "" ? { hint: o.hint } : {}),
    };
  }
  return {
    code: "FAILED",
    message: typeof e === "string" && e !== "" ? e : "the app's shell did not answer",
  };
}

/** One sentence of a refusal: its message, then its hint. */
export const errorText = (e: unknown): string => {
  const c = asCommandError(e);
  return c.hint ? `${c.message}. ${c.hint}` : c.message;
};

/**
 * Runs a command that streams its output (setup, the install into a container) and collects it:
 * listens first, so no line is lost before the run's id is known, keeps the lines of this run
 * only, and resolves when this run is done.
 */
type Streamed<D> =
  | { readonly kind: "output"; readonly runId: string; readonly line: string }
  | ({ readonly kind: "done" } & D);

async function withOutput<D extends { readonly runId: string }>(
  listen: (listener: (e: Streamed<D>) => void) => Promise<() => void>,
  start: () => Promise<{ readonly runId: string }>,
  onLine: (line: string) => void,
): Promise<D> {
  let runId: string | undefined;
  const early: Streamed<D>[] = [];
  let finish: (d: D) => void = () => undefined;
  const finished = new Promise<D>((resolve) => {
    finish = resolve;
  });
  const take = (e: Streamed<D>) => {
    if (e.runId !== runId) return;
    if (e.kind === "output") onLine(e.line);
    else finish(e);
  };
  const stop = await listen((e) => (runId === undefined ? early.push(e) : take(e)));
  try {
    runId = (await start()).runId;
    for (const e of early.splice(0)) take(e);
    return await finished;
  } finally {
    stop();
  }
}

/** Runs setup (in a dev container when `container` is given) and collects its output. */
export function setupWithOutput(
  commands: Pick<Commands, "runSetup" | "onSetup">,
  path: string,
  host: HostId,
  onLine: (line: string) => void,
  container?: string,
): Promise<SetupDone> {
  return withOutput<SetupDone>(
    (l) => commands.onSetup(l),
    () => (container ? commands.runSetup(path, host, container) : commands.runSetup(path, host)),
    onLine,
  );
}

/** Installs MetatorAI into a dev container and collects the install's lines (its progress). */
export function installWithOutput(
  commands: Pick<Commands, "installInContainer" | "onInstall">,
  localFolder: string,
  onLine: (line: string) => void,
): Promise<InstallDone> {
  return withOutput<InstallDone>(
    (l) => commands.onInstall(l),
    () => commands.installInContainer(localFolder),
    onLine,
  );
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type Listen = (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;

/** The wrapper over Tauri's `invoke` and `listen` (`withGlobalTauri`). */
export function tauriCommands(invoke: Invoke, listen: Listen): Commands {
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return (await invoke(command, args)) as T;
    } catch (e) {
      throw asCommandError(e);
    }
  };
  return {
    pickFolder: () => call("pick_folder"),
    inspectFolder: (path, container) => call("inspect_folder", { path, ...inside(container) }),
    runSetup: (path, host, container) => call("run_setup", { path, host, ...inside(container) }),
    onSetup: async (listener) => {
      const stops = await Promise.all([
        listen("setup://output", (e) => listener({ kind: "output", ...(e.payload as SetupOutput) })),
        listen("setup://done", (e) => listener({ kind: "done", ...(e.payload as SetupDone) })),
      ]);
      return () => {
        for (const s of stops) s();
      };
    },
    gitInit: (path, container) => call("git_init", { path, ...inside(container) }),
    commitSetup: (path, files, container) => call("commit_setup", { path, files, ...inside(container) }),
    knownRepos: () => call("known_repos"),
    addRepo: (path, container) => call("add_repo", { path, ...inside(container) }),
    removeRepo: (path) => call("remove_repo", { path }),
    openRepo: (path) => call("open_repo", { path }),
    cliInfo: () => call("cli_info"),
    setCliSource: (source, path) => call("set_cli_source", { source, ...(path ? { path } : {}) }),
    installCliCommand: () => call("install_cli_command"),
    uninstallCliCommand: () => call("uninstall_cli_command"),
    listDevContainers: () => call("list_devcontainers"),
    startDevContainer: (localFolder) => call("start_devcontainer", { localFolder }),
    installInContainer: (localFolder) => call("install_in_container", { localFolder }),
    onInstall: async (listener) => {
      const stops = await Promise.all([
        listen("container://install-output", (e) =>
          listener({ kind: "output", ...(e.payload as InstallOutput) }),
        ),
        listen("container://install-done", (e) => listener({ kind: "done", ...(e.payload as InstallDone) })),
      ]);
      return () => {
        for (const s of stops) s();
      };
    },
    openUri: (uri) => call("open_uri", { uri }),
  };
}

/** The `container` argument, only when there is one: a round-20 call stays as it was. */
const inside = (container: string | undefined): { container?: string } => (container ? { container } : {});

export interface TauriGlobal {
  readonly core?: { readonly invoke?: Invoke };
  readonly event?: { readonly listen?: Listen };
}
