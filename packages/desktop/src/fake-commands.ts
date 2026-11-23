/**
 * A fake of the shell's commands (round 20): the unit tests, and the e2e through its hook (a world
 * put at `window.__METATOR_FAKE__` before the app loads), run the whole Add repository flow with
 * no Tauri, no git and no AI host. It keeps what the commands changed in its world (`known`, a
 * folder set up or made a repository) and records every call in `calls`.
 */
import type {
  CliInfo,
  CliSource,
  Commands,
  HostId,
  InspectedHost,
  InspectedRepository,
  Inspection,
  KnownRepo,
  SetupEvent,
} from "./tauri-commands.ts";

/** A folder of the fake computer. */
export interface FakeFolder {
  kind: "not-git" | "repo" | "folder";
  /** A repository: set up, not yet, or by a newer MetatorAI. */
  setUp?: "yes" | "no" | "newer";
  /** The repository's main checkout when this is a worktree or a folder inside one. */
  root?: string;
  worktree?: boolean;
  /** What setup writes here (for either host). */
  writes?: string[];
  uncommitted?: string[];
  /** A folder of repositories: their paths (each a folder of the world). */
  children?: string[];
}

export interface FakeWorld {
  folders: Record<string, FakeFolder>;
  git?: boolean;
  hosts?: { id: HostId; installed: boolean; loggedIn?: boolean }[];
  known?: KnownRepo[];
  /** What the folder picker returns (null: the person cancelled). */
  picked?: string | null;
  /** The lines setup prints, one every `lineMs`. */
  setupLines?: string[];
  lineMs?: number;
  /** Setup waits after its lines until `__METATOR_FAKE_CONTROL__.finishSetup()` (screenshots). */
  holdSetup?: boolean;
  /** Setup fails with this. */
  setupError?: string;
  /** The daemon's address `open_repo` answers (an e2e's real daemon). */
  url?: string;
  /** `open_repo` refuses with this. */
  openError?: string;
  cli?: CliInfo;
  installedAt?: string;
  calls?: { command: string; args: unknown[] }[];
}

const INSTALL: Readonly<Record<HostId, { url: string; command: string }>> = {
  claude: {
    url: "https://docs.anthropic.com/en/docs/claude-code/setup",
    command: "npm install -g @anthropic-ai/claude-code",
  },
  copilot: {
    url: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
    command: "npm install -g @github/copilot",
  },
};

const nameOf = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? path;

/** What `metator inspect` would answer for a folder of the world. */
export function fakeInspection(world: FakeWorld, path: string): Inspection {
  const order: HostId[] = ["copilot", "claude"];
  const given = world.hosts ?? [
    { id: "copilot", installed: false },
    { id: "claude", installed: true, loggedIn: true },
  ];
  const hosts: InspectedHost[] = order.map((id) => {
    const h = given.find((x) => x.id === id);
    const installed = h?.installed ?? false;
    return {
      id,
      program: id,
      installed,
      loggedIn: installed ? (h?.loggedIn ?? true) : null,
      install: INSTALL[id],
      login: id === "claude" ? "claude, then /login" : "copilot, then /login",
    };
  });
  const defaultHost = hosts.find((h) => h.installed)?.id ?? null;
  const repoOf = (at: string): InspectedRepository => {
    const f = world.folders[at];
    const root = f?.root ?? at;
    return {
      root,
      name: nameOf(root),
      worktree: f?.worktree ?? false,
      setUp: f?.setUp ?? "no",
      config: f?.setUp === "yes" ? "metator.config.yml" : null,
      uncommitted: [...(f?.uncommitted ?? [])],
    };
  };
  const base = {
    path,
    git: { installed: world.git ?? true, version: world.git === false ? null : "2.43.0" },
    hosts,
    defaultHost,
    version: "0.0.0",
  };
  const f = world.folders[path];
  if (!f)
    return { ...base, kind: "missing", next: "choose-another", repository: null, folder: null, writes: {} };
  if (f.kind === "not-git")
    return { ...base, kind: "not-git", next: "git-init", repository: null, folder: null, writes: {} };
  if (f.kind === "folder") {
    const repos = (f.children ?? []).map(repoOf);
    const next = repos.some((r) => r.setUp === "newer")
      ? "update-app"
      : repos.some((r) => r.setUp === "no")
        ? "setup-repos"
        : "add";
    return { ...base, kind: "folder", next, repository: null, folder: { file: null, repos }, writes: {} };
  }
  const repository = repoOf(path);
  const files = world.folders[repository.root]?.writes ?? f.writes ?? [];
  return {
    ...base,
    kind: "repo",
    next: repository.setUp === "newer" ? "update-app" : repository.setUp === "yes" ? "add" : "setup",
    repository,
    folder: null,
    writes: repository.setUp === "no" ? { copilot: files, claude: files } : {},
  };
}

export function fakeCommands(world: FakeWorld, host: unknown = globalThis): Commands {
  world.calls ??= [];
  world.known ??= [];
  const listeners = new Set<(e: SetupEvent) => void>();
  let runs = 0;
  let release: () => void = () => undefined;
  (host as { __METATOR_FAKE_CONTROL__?: unknown }).__METATOR_FAKE_CONTROL__ = {
    finishSetup: () => release(),
  };
  const record = (command: string, ...args: unknown[]) => world.calls?.push({ command, args });
  const refuse = (code: string, message: string, hint?: string) => ({
    code,
    message,
    ...(hint ? { hint } : {}),
  });
  const emit = (e: SetupEvent) => {
    for (const l of listeners) l(e);
  };
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  return {
    pickFolder: async () => {
      record("pick_folder");
      return world.picked ?? null;
    },
    inspectFolder: async (path) => {
      record("inspect_folder", path);
      return fakeInspection(world, path);
    },
    runSetup: async (path, hostId) => {
      record("run_setup", path, hostId);
      const runId = `setup-${++runs}`;
      void (async () => {
        // The answer comes first: the lines follow, as Tauri's events do.
        await sleep(0);
        for (const line of world.setupLines ?? []) {
          await sleep(world.lineMs ?? 20);
          emit({ kind: "output", runId, line });
        }
        if (world.holdSetup)
          await new Promise<void>((done) => {
            release = done;
          });
        if (world.setupError) {
          emit({
            kind: "done",
            runId,
            ok: false,
            written: [],
            error: refuse("COMMAND_FAILED", world.setupError),
          });
          return;
        }
        const folder = world.folders[path];
        const written = [...(folder?.writes ?? [])].sort();
        if (folder)
          world.folders[path] = {
            ...folder,
            setUp: "yes",
            uncommitted: [...new Set([...(folder.uncommitted ?? []), ...written])].sort(),
          };
        emit({ kind: "done", runId, ok: true, written });
      })();
      return { runId };
    },
    onSetup: async (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    gitInit: async (path) => {
      record("git_init", path);
      const folder = world.folders[path];
      if (!folder) throw refuse("NOT_FOUND", `${path} does not exist`);
      world.folders[path] = { ...folder, kind: "repo", setUp: "no" };
    },
    commitSetup: async (path, files) => {
      record("commit_setup", path, [...files]);
      if (files.length === 0) throw refuse("USAGE", "there is nothing to commit");
      const folder = world.folders[path];
      if (folder)
        world.folders[path] = {
          ...folder,
          uncommitted: (folder.uncommitted ?? []).filter((f) => !files.includes(f)),
        };
      return { commit: "4f2c9e1d7a3b5c6e8f9a0b1c2d3e4f5a6b7c8d9e" };
    },
    knownRepos: async () => {
      record("known_repos");
      return [...(world.known ?? [])];
    },
    addRepo: async (path) => {
      record("add_repo", path);
      const there = (world.known ?? []).find((k) => k.path === path);
      if (there) return there;
      const kind = world.folders[path]?.kind === "folder" ? "folder" : "repo";
      const added: KnownRepo = { path, name: nameOf(path), kind, addedAt: new Date().toISOString() };
      world.known = [...(world.known ?? []), added];
      return added;
    },
    removeRepo: async (path) => {
      record("remove_repo", path);
      world.known = (world.known ?? []).filter((k) => k.path !== path);
    },
    openRepo: async (path) => {
      record("open_repo", path);
      if (world.openError) throw refuse("SPAWN", world.openError);
      return { url: world.url ?? "http://127.0.0.1:4310" };
    },
    cliInfo: async () => {
      record("cli_info");
      return world.cli ?? { source: "bundled", path: "/opt/MetatorAI/metator", version: "0.0.0" };
    },
    setCliSource: async (source: CliSource, path?: string) => {
      record("set_cli_source", source, path);
      const before = world.cli ?? { source: "bundled", path: "/opt/MetatorAI/metator", version: "0.0.0" };
      if (source === "custom" && !path) throw refuse("USAGE", "a custom metator needs its path");
      world.cli = {
        ...before,
        source,
        path: path ?? (source === "path" ? "/usr/local/bin/metator" : "/opt/MetatorAI/metator"),
      };
      return world.cli;
    },
    installCliCommand: async () => {
      record("install_cli_command");
      world.installedAt = "/home/you/.local/bin/metator";
      return { path: world.installedAt, onPath: true };
    },
    uninstallCliCommand: async () => {
      record("uninstall_cli_command");
      const path = world.installedAt ?? null;
      delete world.installedAt;
      return { path };
    },
  };
}
