/**
 * The commands of the app's shell (round 20, ADR-0105): what the Tauri window does that a browser
 * tab cannot (pick a folder, inspect it, set it up, commit what setup wrote, remember it, start
 * its daemon). One typed wrapper over Tauri's `invoke`; `fakeCommands` (fake-commands.ts) is the
 * same interface for the tests and the e2e. In a browser there are none (`appCommands` is
 * undefined) and the app shows the commands to run instead.
 */

/** How a command refuses (`ShellError`): the CLI's error code or the shell's (NO_CLI, SPAWN, IO, NEWER_FILE). */
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
}

/** What `metator inspect <path> --json` found (Agent A's shape, passed through; deterministic, read-only). */
export interface Inspection {
  /** The folder looked at, absolute and normalized. */
  readonly path: string;
  readonly kind: "missing" | "not-git" | "repo" | "folder";
  /** What the app offers next. */
  readonly next: "choose-another" | "install-git" | "git-init" | "setup" | "add" | "setup-repos" | "update-app";
  readonly git: {
    readonly installed: boolean;
    readonly version: string | null;
    /** Where git comes from: the app cannot install it. */
    readonly install?: { readonly url: string } | undefined;
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
  readonly path: string;
  readonly name: string;
  readonly kind: "repo" | "folder";
  readonly addedAt: string;
}

export type CliSource = "bundled" | "path" | "custom";

export interface CliInfo {
  readonly source: CliSource;
  /** The program the app runs. */
  readonly path: string;
  /** Its `metator version`; "" when it could not say. */
  readonly version: string;
}

export interface SetupOutput {
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

/** The shell's commands, one method each (the contract's list). */
export interface Commands {
  pickFolder(): Promise<string | null>;
  inspectFolder(path: string): Promise<Inspection>;
  runSetup(path: string, host: HostId): Promise<{ readonly runId: string }>;
  /** Listens to `setup://output` and `setup://done`; resolves to the function that stops listening. */
  onSetup(listener: (e: SetupEvent) => void): Promise<() => void>;
  gitInit(path: string): Promise<void>;
  /** Stages exactly these files and commits "Set up MetatorAI"; answers the full sha. */
  commitSetup(path: string, files: readonly string[]): Promise<{ readonly commit: string }>;
  /** In the order added. */
  knownRepos(): Promise<readonly KnownRepo[]>;
  /** Adding one already there returns it unchanged. */
  addRepo(path: string): Promise<KnownRepo>;
  /** Forgets it; never deletes files. */
  removeRepo(path: string): Promise<void>;
  openRepo(path: string): Promise<{ readonly url: string }>;
  cliInfo(): Promise<CliInfo>;
  setCliSource(source: CliSource, path?: string): Promise<CliInfo>;
  /** onPath false: the folder it wrote in is not on the PATH yet. */
  installCliCommand(): Promise<{ readonly path: string; readonly onPath: boolean }>;
  /** The launcher removed; null when there was none. */
  uninstallCliCommand(): Promise<{ readonly path: string | null }>;
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
 * Runs setup and collects its output: listens first, so no line is lost before the run's id is
 * known, keeps the lines of this run only, and resolves when this run is done.
 */
export async function setupWithOutput(
  commands: Pick<Commands, "runSetup" | "onSetup">,
  path: string,
  host: HostId,
  onLine: (line: string) => void,
): Promise<SetupDone> {
  let runId: string | undefined;
  const early: SetupEvent[] = [];
  let finish: (d: SetupDone) => void = () => undefined;
  const finished = new Promise<SetupDone>((resolve) => {
    finish = resolve;
  });
  const take = (e: SetupEvent) => {
    if (e.runId !== runId) return;
    if (e.kind === "output") onLine(e.line);
    else finish(e);
  };
  const stop = await commands.onSetup((e) => (runId === undefined ? early.push(e) : take(e)));
  try {
    runId = (await commands.runSetup(path, host)).runId;
    for (const e of early.splice(0)) take(e);
    return await finished;
  } finally {
    stop();
  }
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
    inspectFolder: (path) => call("inspect_folder", { path }),
    runSetup: (path, host) => call("run_setup", { path, host }),
    onSetup: async (listener) => {
      const stops = await Promise.all([
        listen("setup://output", (e) => listener({ kind: "output", ...(e.payload as SetupOutput) })),
        listen("setup://done", (e) => listener({ kind: "done", ...(e.payload as SetupDone) })),
      ]);
      return () => {
        for (const s of stops) s();
      };
    },
    gitInit: (path) => call("git_init", { path }),
    commitSetup: (path, files) => call("commit_setup", { path, files }),
    knownRepos: () => call("known_repos"),
    addRepo: (path) => call("add_repo", { path }),
    removeRepo: (path) => call("remove_repo", { path }),
    openRepo: (path) => call("open_repo", { path }),
    cliInfo: () => call("cli_info"),
    setCliSource: (source, path) => call("set_cli_source", { source, ...(path ? { path } : {}) }),
    installCliCommand: () => call("install_cli_command"),
    uninstallCliCommand: () => call("uninstall_cli_command"),
  };
}

export interface TauriGlobal {
  readonly core?: { readonly invoke?: Invoke };
  readonly event?: { readonly listen?: Listen };
}
