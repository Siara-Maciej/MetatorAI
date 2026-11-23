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
  ContainerEngine,
  DevContainer,
  HostFix,
  HostId,
  InspectedHost,
  InspectedRepository,
  Inspection,
  InstallEvent,
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

/** A dev container of the fake engine (round 21): what the engine lists, and its own folders and tools. */
export interface FakeContainer {
  id: string;
  name: string;
  localFolder: string;
  configFile?: string | null;
  state: "running" | "stopped";
  workspaceFolder: string | null;
  remoteUser?: string;
  image?: string;
  /** The folders inside it. */
  folders: Record<string, FakeFolder>;
  git?: boolean;
  hosts?: { id: HostId; installed: boolean; loggedIn?: boolean }[];
  /** The MetatorAI version installed in it; none yet when absent. */
  installed?: string;
}

export interface FakeWorld {
  folders: Record<string, FakeFolder>;
  /** The container CLI found (round 21); null: neither docker nor nerdctl. Default: docker. */
  engine?: ContainerEngine | null;
  containers?: FakeContainer[];
  /** The lines the install into a container prints, one every `lineMs`. */
  installLines?: string[];
  /** The install waits after its lines until `__METATOR_FAKE_CONTROL__.finishInstall()`. */
  holdInstall?: boolean;
  /** The install fails with this (e.g. { code: "MUSL", message }). */
  installError?: { code: string; message: string };
  /** The links `open_uri` opened. */
  opened?: string[];
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

/** The engine's words for adding a host to a dev container (Agent A's shell gives the real ones). */
const FIX: Readonly<Record<HostId, HostFix>> = {
  claude: {
    feature: '"ghcr.io/anthropics/devcontainer-features/claude-code:1": {}',
    command: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  copilot: { command: "npm install -g @github/copilot" },
};

const GIT_FIX: HostFix = {
  feature: '"ghcr.io/devcontainers/features/git:1": {}',
  command: "sudo apt-get update && sudo apt-get install -y git",
};

const DOCKER: ContainerEngine = { program: "docker", context: "rancher-desktop", version: "27.3.1" };

const nameOf = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? path;

/** What `metator inspect` would answer for a folder of the world (or of a container: `fixes`). */
export function fakeInspection(
  world: Pick<FakeWorld, "folders" | "git" | "hosts">,
  path: string,
  fixes = false,
): Inspection {
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
      ...(fixes ? { fix: FIX[id] } : {}),
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
    git: {
      installed: world.git ?? true,
      version: world.git === false ? null : "2.43.0",
      ...(fixes ? { fix: GIT_FIX } : {}),
    },
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
  const installs = new Set<(e: InstallEvent) => void>();
  let runs = 0;
  let release: () => void = () => undefined;
  let releaseInstall: () => void = () => undefined;
  (host as { __METATOR_FAKE_CONTROL__?: unknown }).__METATOR_FAKE_CONTROL__ = {
    finishSetup: () => release(),
    finishInstall: () => releaseInstall(),
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
  const containerOf = (localFolder: string): FakeContainer => {
    const c = (world.containers ?? []).find((x) => x.localFolder === localFolder);
    if (!c) throw refuse("CONTAINER_MISSING", `no dev container of ${localFolder}`);
    return c;
  };
  /** The container a command runs in: it must run, and MetatorAI must be installed there. */
  const running = (localFolder: string): FakeContainer => {
    const c = containerOf(localFolder);
    if (c.state !== "running")
      throw refuse("CONTAINER_STOPPED", `the dev container of ${nameOf(localFolder)} is stopped`);
    return c;
  };
  /** The folders a command works on: this computer's, or a container's. */
  const foldersOf = (container: string | undefined): Record<string, FakeFolder> =>
    container ? running(container).folders : world.folders;
  const listed = (c: FakeContainer): DevContainer => ({
    id: c.id,
    name: c.name,
    localFolder: c.localFolder,
    configFile: c.configFile ?? `${c.localFolder}/.devcontainer/devcontainer.json`,
    state: c.state,
    workspaceFolder: c.workspaceFolder,
    remoteUser: c.remoteUser ?? "vscode",
    image: c.image ?? "mcr.microsoft.com/devcontainers/base:bookworm",
    editorUri: editorUriOf(c.localFolder),
  });
  return {
    pickFolder: async () => {
      record("pick_folder");
      return world.picked ?? null;
    },
    inspectFolder: async (path, container) => {
      record("inspect_folder", path, ...(container ? [container] : []));
      if (!container) return fakeInspection(world, path);
      const c = running(container);
      return fakeInspection(
        {
          folders: c.folders,
          ...(c.git === undefined ? {} : { git: c.git }),
          ...(c.hosts ? { hosts: c.hosts } : {}),
        },
        path,
        true,
      );
    },
    runSetup: async (path, hostId, container) => {
      record("run_setup", path, hostId, ...(container ? [container] : []));
      const folders = foldersOf(container);
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
        const folder = folders[path];
        const written = [...(folder?.writes ?? [])].sort();
        if (folder)
          folders[path] = {
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
    gitInit: async (path, container) => {
      record("git_init", path, ...(container ? [container] : []));
      const folders = foldersOf(container);
      const folder = folders[path];
      if (!folder) throw refuse("NOT_FOUND", `${path} does not exist`);
      folders[path] = { ...folder, kind: "repo", setUp: "no" };
    },
    commitSetup: async (path, files, container) => {
      record("commit_setup", path, [...files], ...(container ? [container] : []));
      if (files.length === 0) throw refuse("USAGE", "there is nothing to commit");
      const folders = foldersOf(container);
      const folder = folders[path];
      if (folder)
        folders[path] = {
          ...folder,
          uncommitted: (folder.uncommitted ?? []).filter((f) => !files.includes(f)),
        };
      return { commit: "4f2c9e1d7a3b5c6e8f9a0b1c2d3e4f5a6b7c8d9e" };
    },
    knownRepos: async () => {
      record("known_repos");
      return [...(world.known ?? [])];
    },
    addRepo: async (path, container) => {
      record("add_repo", path, ...(container ? [container] : []));
      if (container) {
        // A dev container's repository is known by its local folder label: stable across rebuilds.
        const c = containerOf(container);
        const key = `devcontainer:${c.localFolder}`;
        const there = (world.known ?? []).find((k) => k.path === key);
        if (there) return there;
        const added: KnownRepo = {
          path: key,
          name: nameOf(c.localFolder),
          kind: "devcontainer",
          addedAt: new Date().toISOString(),
          devcontainer: {
            localFolder: c.localFolder,
            workspaceFolder: path,
            configFile: c.configFile ?? null,
            editorUri: editorUriOf(c.localFolder),
          },
        };
        world.known = [...(world.known ?? []), added];
        return added;
      }
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
      const known = (world.known ?? []).find((k) => k.path === path);
      if (known?.devcontainer) running(known.devcontainer.localFolder);
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
    listDevContainers: async () => {
      record("list_devcontainers");
      const engine = world.engine === undefined ? DOCKER : world.engine;
      return engine
        ? { engine, containers: (world.containers ?? []).map(listed), problem: null }
        : { engine, containers: [], problem: "neither docker nor nerdctl was found on this computer" };
    },
    startDevContainer: async (localFolder) => {
      record("start_devcontainer", localFolder);
      if (world.engine === null) throw refuse("NO_ENGINE", "no container engine answers");
      const c = containerOf(localFolder);
      await sleep(world.lineMs ?? 20);
      c.state = "running";
      return listed(c);
    },
    installInContainer: async (localFolder) => {
      record("install_in_container", localFolder);
      const c = running(localFolder);
      const runId = `install-${++runs}`;
      const emitInstall = (e: InstallEvent) => {
        for (const l of installs) l(e);
      };
      void (async () => {
        await sleep(0);
        for (const line of world.installLines ?? []) {
          await sleep(world.lineMs ?? 20);
          emitInstall({ kind: "output", runId, line });
        }
        if (world.holdInstall)
          await new Promise<void>((done) => {
            releaseInstall = done;
          });
        if (world.installError) {
          const e = world.installError;
          emitInstall({ kind: "done", runId, ok: false, error: refuse(e.code, e.message) });
          return;
        }
        c.installed = "0.0.0";
        emitInstall({ kind: "done", runId, ok: true, version: "0.0.0", path: "~/.metator/server/0.0.0" });
      })();
      return { runId };
    },
    onInstall: async (listener) => {
      installs.add(listener);
      return () => installs.delete(listener);
    },
    openUri: async (uri) => {
      record("open_uri", uri);
      world.opened = [...(world.opened ?? []), uri];
    },
  };
}

/** The engine's editor link: the local folder as hex, the way the Dev Containers extension names a container. */
const editorUriOf = (localFolder: string): string =>
  `vscode://vscode-remote/dev-container+${[...new TextEncoder().encode(localFolder)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
