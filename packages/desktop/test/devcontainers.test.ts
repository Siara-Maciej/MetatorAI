import { describe, expect, test } from "bun:test";
import {
  type ContainerEvent,
  type ContainerFlow,
  containerDown,
  containerRows,
  containerStep,
  editorChoice,
  engineText,
  folderName,
  inContainer,
  installErrorText,
  installLine,
  LISTING,
  readContainerList,
  statesOf,
} from "../src/devcontainers.ts";
import { type FakeContainer, type FakeWorld, fakeCommands } from "../src/fake-commands.ts";
import {
  alreadyAdded,
  containerStateOf,
  readInspection,
  repoName,
  requirements,
  shellView,
  switcherLabel,
  switcherRows,
} from "../src/repos.ts";
import {
  type DevContainer,
  type DevContainerList,
  type Inspection,
  type InstallEvent,
  installWithOutput,
  type KnownRepo,
  tauriCommands,
} from "../src/tauri-commands.ts";

const DOCKER = { program: "docker", context: "rancher-desktop", version: "27.3.1" } as const;
const URI = "vscode://vscode-remote/dev-container+633a5c776f726b5c73686f70";

const box = (more: Partial<DevContainer> & Pick<DevContainer, "localFolder">): DevContainer => ({
  id: "c1",
  name: "shop_devcontainer-app-1",
  configFile: null,
  state: "running",
  workspaceFolder: "/workspaces/shop",
  remoteUser: "vscode",
  image: "mcr.microsoft.com/devcontainers/base:bookworm",
  editorUri: URI,
  ...more,
});

const SHOP = box({ localFolder: "c:\\work\\shop" });
const NOTES = box({
  id: "c2",
  localFolder: "c:\\work\\notes",
  state: "stopped",
  workspaceFolder: "/workspaces/notes",
});
const BARE = box({ id: "c3", localFolder: "/home/you/bare", workspaceFolder: null });
const LIST: DevContainerList = { engine: DOCKER, containers: [SHOP, NOTES, BARE], problem: null };

const known = (more: Partial<KnownRepo> = {}): KnownRepo => ({
  path: "devcontainer:c:\\work\\shop",
  name: "shop",
  kind: "devcontainer",
  addedAt: "2026-11-23T10:00:00Z",
  devcontainer: {
    localFolder: "c:\\work\\shop",
    workspaceFolder: "/workspaces/shop",
    configFile: null,
    editorUri: URI,
  },
  ...more,
});

const run = (events: readonly ContainerEvent[], from: ContainerFlow = LISTING): ContainerFlow =>
  events.reduce(containerStep, from);

describe("the engine's list in plain words (round 21)", () => {
  test("no engine: Docker Desktop and Rancher Desktop with their links, and the shell's reason", () => {
    const r = readContainerList({
      engine: null,
      containers: [],
      problem: "docker is installed, but its engine does not answer",
    });
    expect(r.kind).toBe("no-engine");
    expect(r.title).toBe("No container engine found");
    expect(r.links.map((l) => l.name)).toEqual(["Docker Desktop", "Rancher Desktop"]);
    expect(r.lines).toContain("Docker is installed, but its engine does not answer.");
    expect(r.lines.at(-1)).toBe("Install one, or start it if it is installed, then press Refresh.");
    expect(readContainerList({ engine: null, containers: [], problem: null }).lines).toHaveLength(2);
  });

  test("an engine with no dev container: open it once in VS Code, or devcontainer up", () => {
    const r = readContainerList({ engine: DOCKER, containers: [], problem: null });
    expect(r.kind).toBe("none");
    expect(r.title).toBe("No dev container yet");
    expect(r.lines.join(" ")).toContain("Reopen in Container");
    expect(r.lines.join(" ")).toContain("devcontainer up");
    expect(r.links).toEqual([]);
  });

  test("containers found: how many, through which engine and context", () => {
    const r = readContainerList(LIST);
    expect(r.kind).toBe("list");
    expect(r.title).toBe("3 dev containers on this computer");
    expect(r.lines).toEqual(["Found through docker (context rancher-desktop)."]);
    expect(engineText({ program: "nerdctl", context: null, version: "2.0" })).toBe("nerdctl");
  });
});

describe("the rows of the Dev Container source", () => {
  test("by the local folder's name; a stopped one offers Start, a running one Choose", () => {
    const rows = containerRows(LIST, []);
    expect(rows.map((r) => [r.name, r.state, r.workspace, r.button])).toEqual([
      ["bare", "running", "", undefined],
      ["notes", "stopped", "/workspaces/notes", "Start"],
      ["shop", "running", "/workspaces/shop", "Choose"],
    ]);
    expect(rows[0]?.note).toBe("no workspace folder found in it");
    expect(rows[0]?.action).toBe("none");
    expect(rows[2]?.key).toBe("c:\\work\\shop");
  });

  test("one the app knows already is opened, not set up again", () => {
    const rows = containerRows(LIST, [known()]);
    const shop = rows.find((r) => r.name === "shop");
    expect(shop?.action).toBe("open");
    expect(shop?.button).toBe("Open");
    expect(shop?.note).toBe("already in the app");
  });

  test("a stopped container the app knows still offers Start first", () => {
    const rows = containerRows({ ...LIST, containers: [{ ...SHOP, state: "stopped" }] }, [known()]);
    expect(rows[0]?.action).toBe("start");
  });

  test("a folder's name from a Windows or a POSIX path", () => {
    expect(folderName("c:\\work\\shop\\")).toBe("shop");
    expect(folderName("/home/you/shop")).toBe("shop");
    expect(folderName("shop")).toBe("shop");
  });
});

describe("the Dev Container source's steps", () => {
  test("list → Start a stopped one → it runs → pick → install lines → installed", () => {
    const s = run([
      { type: "listed", list: LIST },
      { type: "start", key: NOTES.localFolder },
    ]);
    expect(s.step).toBe("starting");
    const started = run([{ type: "started", container: { ...NOTES, state: "running" } }], s);
    expect(started.step).toBe("listed");
    expect(started.list?.containers.find((c) => c.localFolder === NOTES.localFolder)?.state).toBe("running");
    const installing = run(
      [
        { type: "pick", key: NOTES.localFolder },
        { type: "line", line: "Copying MetatorAI 0.9.0 (x64)…" },
        { type: "line", line: "Unpacking…" },
      ],
      started,
    );
    expect(installing.step).toBe("installing");
    if (installing.step !== "installing") throw new Error("not installing");
    expect(installing.container.localFolder).toBe(NOTES.localFolder);
    expect(installLine(installing.lines)).toBe("Unpacking…");
    const done = run([{ type: "installed", version: "0.9.0" }], installing);
    expect(done).toEqual({
      step: "installed",
      list: installing.list,
      container: installing.container,
      version: "0.9.0",
    });
    // Change goes back to the list.
    expect(run([{ type: "back" }], done)).toEqual({ step: "listed", list: installing.list });
  });

  test("Start only for a stopped one; pick only a running one with a workspace folder", () => {
    const listed = run([{ type: "listed", list: LIST }]);
    expect(run([{ type: "start", key: SHOP.localFolder }], listed)).toBe(listed);
    expect(run([{ type: "pick", key: NOTES.localFolder }], listed)).toBe(listed);
    expect(run([{ type: "pick", key: BARE.localFolder }], listed)).toBe(listed);
    expect(run([{ type: "pick", key: "nowhere" }], listed)).toBe(listed);
    expect(run([{ type: "pick", key: SHOP.localFolder }], listed).step).toBe("installing");
  });

  test("a failure returns to the list with its words; the list is kept", () => {
    expect(run([{ type: "failed", error: "docker hung" }])).toEqual({
      step: "listed",
      list: { engine: null, containers: [], problem: null },
      error: "docker hung",
    });
    const starting = run([
      { type: "listed", list: LIST },
      { type: "start", key: NOTES.localFolder },
      { type: "failed", error: "no space left" },
    ]);
    expect(starting).toEqual({ step: "listed", list: LIST, error: "no space left" });
    const installing = run([
      { type: "listed", list: LIST },
      { type: "pick", key: SHOP.localFolder },
      { type: "failed", error: "MUSL" },
    ]);
    expect(installing).toEqual({ step: "listed", list: LIST, error: "MUSL" });
  });

  test("Refresh keeps the old list while it reads; a busy step takes no new act", () => {
    const listed = run([{ type: "listed", list: LIST }]);
    const refreshing = run([{ type: "refresh" }], listed);
    expect(refreshing).toEqual({ step: "listing", list: LIST });
    expect(run([{ type: "refresh" }], refreshing)).toBe(refreshing);
    expect(run([{ type: "start", key: NOTES.localFolder }], refreshing)).toBe(refreshing);
    expect(run([{ type: "line", line: "x" }], listed)).toBe(listed);
    expect(run([{ type: "installed", version: "1" }], listed)).toBe(listed);
    expect(run([{ type: "started", container: SHOP }], listed)).toBe(listed);
    expect(run([{ type: "back" }], listed)).toBe(listed);
    expect(run([{ type: "listed", list: LIST }], listed)).toBe(listed);
    expect(run([{ type: "failed", error: "x" }], listed)).toBe(listed);
  });

  test("an install's line before any output; Alpine is named, the rest is the shell's sentence", () => {
    expect(installLine([])).toBe("Connecting to the container…");
    expect(installLine(["Copying…", "  "])).toBe("Copying…");
    expect(installErrorText({ code: "MUSL", message: "musl" }, "musl")).toContain("needs glibc");
    expect(installErrorText({ code: "UNSUPPORTED", message: "riscv64" }, "riscv64. use x64")).toBe(
      "riscv64. use x64",
    );
  });
});

describe("the same Add repository flow, in the container", () => {
  test("the inspection reads 'in the container'", () => {
    const base: Inspection = {
      path: "/workspaces/shop",
      kind: "repo",
      next: "setup",
      git: { installed: true, version: "2.39.5" },
      repository: {
        root: "/workspaces/shop",
        name: "shop",
        worktree: false,
        setUp: "no",
        config: null,
        uncommitted: [],
      },
      folder: null,
      hosts: [
        {
          id: "claude",
          program: "claude",
          installed: true,
          loggedIn: true,
          install: { url: "u", command: "c" },
          login: "claude, then /login",
        },
      ],
      defaultHost: "claude",
      writes: { claude: ["metator.config.yml"] },
      version: "0.9.0",
    };
    expect(readInspection(base, "claude", "container").title).toBe(
      "MetatorAI is not set up in the container yet",
    );
    expect(readInspection(base, "claude").title).toBe("MetatorAI is not set up here yet");
    expect(readInspection({ ...base, next: "add" }, "claude", "container").title).toBe(
      "MetatorAI is already set up in the container",
    );
    const noGit = readInspection(
      { ...base, git: { installed: false, version: null } },
      "claude",
      "container",
    );
    expect(noGit.title).toBe("git is not installed in the container");
    expect(noGit.lines[0]).toContain("Add it to the container");
    const noHost = readInspection({ ...base, hosts: [] }, undefined, "container");
    expect(noHost.title).toBe("No AI host is installed in the container");
    expect(noHost.lines.at(-1)).toContain("Add one to the container");
    expect(
      readInspection({ ...base, kind: "missing", next: "choose-another" }, "claude", "container").title,
    ).toBe("There is no such folder in the container");
  });

  test("the host check in the container carries the engine's fix, for a missing program only", async () => {
    const w: FakeWorld = {
      folders: {},
      containers: [
        {
          ...container(),
          git: false,
          hosts: [
            { id: "copilot", installed: false },
            { id: "claude", installed: false },
          ],
        },
      ],
    };
    const i = await fakeCommands(w, {}).inspectFolder("/workspaces/shop", SHOP.localFolder);
    const rs = requirements(i);
    expect(rs.map((r) => [r.id, r.ok, r.fix?.feature ?? r.fix?.command])).toEqual([
      ["git", false, '"ghcr.io/devcontainers/features/git:1": {}'],
      ["copilot", false, "npm install -g @github/copilot"],
      ["claude", false, '"ghcr.io/anthropics/devcontainer-features/claude-code:1": {}'],
    ]);
    // Installed but not logged in: what to type, no install fix.
    const loggedOut = requirements({
      ...i,
      git: { installed: true, version: "2", fix: { command: "apt-get install git" } },
      hosts: i.hosts.map((h) => ({ ...h, installed: true, loggedIn: false })),
    });
    expect(loggedOut.every((r) => r.fix === undefined)).toBe(true);
    expect(loggedOut[1]?.problem).toBe("not logged in: run copilot, then /login");
    // On this computer there is no fix.
    expect(requirements({ ...i, git: { installed: false, version: null } })[0]?.fix).toBeUndefined();
  });

  test("the round-20 commands, each bound to the container", async () => {
    const seen: unknown[][] = [];
    const note = <T>(what: string, a: unknown[], answer: T): T => {
      seen.push([what, ...a]);
      return answer;
    };
    const commands = {
      inspectFolder: async (...a: unknown[]) => note("inspect", a, {} as Inspection),
      runSetup: async (...a: unknown[]) => note("setup", a, { runId: "r" }),
      onSetup: async () => () => undefined,
      gitInit: async (...a: unknown[]) => note("init", a, undefined),
      commitSetup: async (...a: unknown[]) => note("commit", a, { commit: "abc" }),
    };
    const c = inContainer(commands, "c:\\work\\shop");
    await c.inspectFolder("/w");
    await c.runSetup("/w", "claude");
    await c.gitInit("/w");
    await c.commitSetup("/w", ["a"]);
    expect(seen).toEqual([
      ["inspect", "/w", "c:\\work\\shop"],
      ["setup", "/w", "claude", "c:\\work\\shop"],
      ["init", "/w", "c:\\work\\shop"],
      ["commit", "/w", ["a"], "c:\\work\\shop"],
    ]);
  });

  test("a known container is the one already added, whatever folder its inspection names", () => {
    const i = { path: "/workspaces/shop", folder: null, repository: null } as unknown as Inspection;
    expect(alreadyAdded([known()], i, "c:\\work\\shop")?.path).toBe("devcontainer:c:\\work\\shop");
    expect(alreadyAdded([known()], i, "c:\\work\\other")).toBeUndefined();
    // A folder on this computer never matches a dev container's entry.
    const onHost = { ...i, path: "devcontainer:c:\\work\\shop" } as Inspection;
    expect(alreadyAdded([known()], onHost)).toBeUndefined();
  });
});

describe("the switcher, Settings and a container that stopped", () => {
  const rows = (states?: Record<string, "running" | "stopped">) =>
    switcherRows(
      [known(), { path: "/home/you/api", name: "api", kind: "repo", addedAt: "2026-11-23T09:00:00Z" }],
      "devcontainer:c:\\work\\shop",
      states,
    );

  test("a dev container's entry reads 'shop (Dev Container)', with its container's state", () => {
    expect(rows().map((r) => [r.name, r.note, r.state, r.current])).toEqual([
      ["api", "", undefined, false],
      ["shop (Dev Container)", "", undefined, true],
    ]);
    expect(rows({ "c:\\work\\shop": "stopped" })[1]?.note).toBe("stopped");
    expect(rows({ "c:\\work\\shop": "running" })[1]?.note).toBe("running");
    // Listed by an engine that no longer has it: not found.
    expect(rows({})[1]?.state).toBe("missing");
    expect(rows({})[1]?.note).toBe("container not found");
    expect(switcherLabel(known(), "1 repository")).toBe("shop (Dev Container)");
    expect(repoName({ name: "api", kind: "repo" })).toBe("api");
  });

  test("the states come from the engine's list; none while the engine has not answered", () => {
    expect(statesOf(LIST)).toEqual({
      "c:\\work\\shop": "running",
      "c:\\work\\notes": "stopped",
      "/home/you/bare": "running",
    });
    expect(statesOf(undefined)).toBeUndefined();
    expect(statesOf({ engine: null, containers: [], problem: "x" })).toBeUndefined();
    expect(containerStateOf(known(), undefined)).toBeUndefined();
    expect(containerStateOf({ devcontainer: undefined }, {})).toBeUndefined();
  });

  test("a dev container that stopped or dropped has its own panel, not the daemon's", () => {
    const at = { commands: true, known: [known()], screen: "inbox" };
    expect(shellView({ ...at, down: true, current: known() })).toBe("container-down");
    expect(shellView({ ...at, down: false, current: known(), startFailed: true })).toBe("container-down");
    expect(shellView({ ...at, down: false, current: known(), startFailed: false })).toBe("screens");
    expect(shellView({ ...at, down: true, current: { kind: "repo" } })).toBe("no-daemon");
    expect(shellView({ ...at, down: false, current: { kind: "repo" }, startFailed: true })).toBe("screens");
    expect(shellView({ ...at, down: true, current: known(), screen: "add" })).toBe("add");
  });

  test("stopped: Start and Reconnect; running: Reconnect; gone: how to make it again", () => {
    const stopped = containerDown(known(), { "c:\\work\\shop": "stopped" });
    expect(stopped.title).toBe("The container stopped");
    expect([stopped.start, stopped.reconnect]).toEqual([true, true]);
    const running = containerDown(known(), { "c:\\work\\shop": "running" });
    expect([running.start, running.reconnect]).toEqual([false, true]);
    const gone = containerDown(known(), {});
    expect(gone.title).toBe("The container is not there");
    expect(gone.start).toBe(false);
    expect(gone.lines[0]).toContain("devcontainer up");
    const unknown = containerDown(known(), undefined);
    expect([unknown.start, unknown.reconnect]).toEqual([true, true]);
  });
});

describe("where the editor opens", () => {
  test("a repository on this computer: the daemon's editor", () => {
    expect(editorChoice(undefined, {})).toEqual({ kind: "daemon" });
    expect(
      editorChoice({ path: "/p", name: "p", kind: "repo", addedAt: "" }, { file: "a.ts", line: 3 }),
    ).toEqual({ kind: "daemon" });
  });

  test("a dev container's: VS Code on this computer, at the path inside the container and the line", () => {
    expect(editorChoice(known(), { file: "src/a.ts", line: 12 })).toEqual({
      kind: "host",
      uri: `${URI}/workspaces/shop/src/a.ts:12`,
    });
    // A run's worktree is relative to the repository; a folder has no line.
    expect(editorChoice(known(), { worktree: ".metator/worktrees/fix-tax" })).toEqual({
      kind: "host",
      uri: `${URI}/workspaces/shop/.metator/worktrees/fix-tax`,
    });
    expect(editorChoice(known(), { worktree: ".metator/worktrees/fix-tax", file: "b.ts", line: 4 })).toEqual({
      kind: "host",
      uri: `${URI}/workspaces/shop/.metator/worktrees/fix-tax/b.ts:4`,
    });
    // A pane's directory is absolute; a path with spaces is encoded.
    expect(editorChoice(known(), { cwd: "/workspaces/shop/my dir", line: 9 })).toEqual({
      kind: "host",
      uri: `${URI}/workspaces/shop/my%20dir`,
    });
  });

  test("no link from the engine: the app says so; it never runs an editor in the container", () => {
    const k = known();
    const bare = {
      ...k,
      devcontainer: { ...(k.devcontainer as NonNullable<KnownRepo["devcontainer"]>), editorUri: "" },
    };
    expect(editorChoice(bare, {}).kind).toBe("none");
  });
});

function container(more: Partial<FakeContainer> = {}): FakeContainer {
  return {
    id: "c1",
    name: "shop_devcontainer-app-1",
    localFolder: SHOP.localFolder,
    state: "running",
    workspaceFolder: "/workspaces/shop",
    folders: { "/workspaces/shop": { kind: "repo", setUp: "no", writes: ["metator.config.yml"] } },
    ...more,
  };
}

describe("the shell's dev-container commands: the wrapper and the fake", () => {
  test("each is invoked by its name; `container` only when there is one", async () => {
    const calls: [string, unknown][] = [];
    const c = tauriCommands(
      async (command, args) => {
        calls.push([command, args]);
        return command === "install_in_container" ? { runId: "i1" } : null;
      },
      async () => () => undefined,
    );
    await c.listDevContainers();
    await c.startDevContainer("c:\\shop");
    await c.installInContainer("c:\\shop");
    await c.inspectFolder("/w", "c:\\shop");
    await c.runSetup("/w", "claude", "c:\\shop");
    await c.gitInit("/w", "c:\\shop");
    await c.commitSetup("/w", ["a"], "c:\\shop");
    await c.addRepo("/w", "c:\\shop");
    await c.addRepo("/home/you/api");
    await c.openUri(`${URI}/w`);
    expect(calls).toEqual([
      ["list_devcontainers", undefined],
      ["start_devcontainer", { localFolder: "c:\\shop" }],
      ["install_in_container", { localFolder: "c:\\shop" }],
      ["inspect_folder", { path: "/w", container: "c:\\shop" }],
      ["run_setup", { path: "/w", host: "claude", container: "c:\\shop" }],
      ["git_init", { path: "/w", container: "c:\\shop" }],
      ["commit_setup", { path: "/w", files: ["a"], container: "c:\\shop" }],
      ["add_repo", { path: "/w", container: "c:\\shop" }],
      ["add_repo", { path: "/home/you/api" }],
      ["open_uri", { uri: `${URI}/w` }],
    ]);
  });

  test("the install's events come through listen; its lines are collected for its run only", async () => {
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    const c = tauriCommands(
      async () => {
        handlers.get("container://install-output")?.({ payload: { runId: "other", line: "not mine" } });
        handlers.get("container://install-output")?.({ payload: { runId: "i1", line: "early" } });
        queueMicrotask(() => {
          handlers.get("container://install-output")?.({ payload: { runId: "i1", line: "late" } });
          handlers.get("container://install-done")?.({
            payload: { runId: "i1", ok: true, version: "0.9.0", path: "/home/vscode/.metator/server/0.9.0" },
          });
        });
        return { runId: "i1" };
      },
      async (name, h) => {
        handlers.set(name, h);
        return () => handlers.delete(name);
      },
    );
    const lines: string[] = [];
    const done = await installWithOutput(c, "c:\\shop", (l) => lines.push(l));
    expect(lines).toEqual(["early", "late"]);
    expect(done.version).toBe("0.9.0");
    expect(handlers.size).toBe(0);
  });

  test("the fake: list, Start, install, the flow in the container, add, open", async () => {
    const w: FakeWorld = {
      folders: {},
      containers: [container({ state: "stopped" })],
      installLines: ["Copying…"],
      lineMs: 1,
      url: "http://127.0.0.1:4999",
    };
    const c = fakeCommands(w, {});
    const list = await c.listDevContainers();
    expect(list.containers[0]?.state).toBe("stopped");
    expect(list.containers[0]?.editorUri).toBe(URI);
    // A stopped container refuses everything but Start.
    expect(await c.installInContainer(SHOP.localFolder).catch((e: unknown) => e)).toMatchObject({
      code: "CONTAINER_STOPPED",
    });
    expect((await c.startDevContainer(SHOP.localFolder)).state).toBe("running");
    const events: InstallEvent[] = [];
    await c.onInstall((e) => events.push(e));
    const lines: string[] = [];
    const done = await installWithOutput(c, SHOP.localFolder, (l) => lines.push(l));
    expect([lines, done.ok, done.version]).toEqual([["Copying…"], true, "0.0.0"]);
    const i = await c.inspectFolder("/workspaces/shop", SHOP.localFolder);
    expect(i.next).toBe("setup");
    const added = await c.addRepo("/workspaces/shop", SHOP.localFolder);
    expect(added).toMatchObject({
      path: "devcontainer:c:\\work\\shop",
      name: "shop",
      kind: "devcontainer",
      devcontainer: { localFolder: SHOP.localFolder, workspaceFolder: "/workspaces/shop", editorUri: URI },
    });
    expect(await c.addRepo("/workspaces/shop", SHOP.localFolder)).toBe(added);
    expect((await c.openRepo(added.path)).url).toBe("http://127.0.0.1:4999");
    const box0 = w.containers?.[0];
    if (box0) box0.state = "stopped";
    expect(await c.openRepo(added.path).catch((e: unknown) => e)).toMatchObject({
      code: "CONTAINER_STOPPED",
    });
    expect(await c.startDevContainer("nowhere").catch((e: unknown) => e)).toMatchObject({
      code: "CONTAINER_MISSING",
    });
    await c.openUri(`${URI}/workspaces/shop`);
    expect(w.opened).toEqual([`${URI}/workspaces/shop`]);
  });

  test("the fake with no engine, and an install that fails on Alpine", async () => {
    const none = fakeCommands({ folders: {}, engine: null }, {});
    expect(await none.listDevContainers()).toEqual({
      engine: null,
      containers: [],
      problem: "neither docker nor nerdctl was found on this computer",
    });
    expect(await none.startDevContainer("x").catch((e: unknown) => e)).toMatchObject({ code: "NO_ENGINE" });
    const alpine = fakeCommands(
      { folders: {}, containers: [container()], installError: { code: "MUSL", message: "musl libc" } },
      {},
    );
    const done = await installWithOutput(alpine, SHOP.localFolder, () => undefined);
    expect(done).toMatchObject({ ok: false, error: { code: "MUSL" } });
  });
});
