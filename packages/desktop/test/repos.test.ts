import { describe, expect, test } from "bun:test";
import {
  afterRemove,
  alreadyAdded,
  cliSourceText,
  commitQuestion,
  currentRepo,
  defaultHost,
  type Flow,
  type FlowEvent,
  flowStep,
  hostChoices,
  installedText,
  pathOf,
  progressLine,
  readInspection,
  ready,
  requirements,
  START,
  shellPath,
  shellView,
  shortSha,
  switcherLabel,
  switcherRows,
  webCommands,
  writesFor,
} from "../src/features/repos/repos.ts";
import { appCommands } from "../src/shared/platform/app-commands.ts";
import { type FakeWorld, fakeCommands, fakeInspection } from "../src/shared/platform/fake-commands.ts";
import {
  asCommandError,
  errorText,
  type Inspection,
  type KnownRepo,
  type SetupEvent,
  setupWithOutput,
  tauriCommands,
} from "../src/shared/platform/tauri-commands.ts";

const SHOP = "/home/you/shop";
const FILES = [".github/agents/mt-implementer.agent.md", "metator.config.yml", "metator/install.lock.json"];

const world = (more: Partial<FakeWorld> = {}): FakeWorld => ({
  folders: {
    [SHOP]: { kind: "repo", setUp: "no", writes: FILES },
    "/home/you/notes": { kind: "not-git" },
    "/home/you/done": { kind: "repo", setUp: "yes" },
    "/home/you/new": { kind: "repo", setUp: "newer" },
    "/home/you/shop-fix": { kind: "repo", root: SHOP, worktree: true },
    "/home/you/work": { kind: "folder", children: ["/home/you/work/a", "/home/you/work/b"] },
    "/home/you/work/a": { kind: "repo", setUp: "yes" },
    "/home/you/work/b": { kind: "repo", setUp: "no", writes: ["metator.config.yml"] },
  },
  ...more,
});
const inspect = (path: string, more: Partial<FakeWorld> = {}): Inspection =>
  fakeInspection(world(more), path);
const run = (events: readonly FlowEvent[], from: Flow = START): Flow => events.reduce(flowStep, from);

describe("an inspection in plain words, with one next action (round 20)", () => {
  test("a repository not set up says how many files setup writes and offers Set up", () => {
    const r = readInspection(inspect(SHOP));
    expect(r.kind).toBe("not-set-up");
    expect(r.title).toBe("MetatorAI is not set up here yet");
    expect(r.lines).toContain("Setup will write 3 files. Nothing is committed unless you say so.");
    expect(r.action).toBe("Set up");
  });

  test("a Java repository says what it is in one line, first; set up or not (round 22)", () => {
    const stack = {
      languages: ["Java"],
      builds: [{ tool: "maven", wrapper: false, modules: 14, label: "Maven" }],
      line: "Java · Maven, 14 modules",
    };
    const java = (setUp: "yes" | "no") =>
      readInspection(
        fakeInspection(world({ folders: { [SHOP]: { kind: "repo", setUp, writes: FILES, stack } } }), SHOP),
      );
    expect(java("no").lines).toEqual([
      "Java · Maven, 14 modules",
      "Setup will write 3 files. Nothing is committed unless you say so.",
    ]);
    expect(java("yes").lines[0]).toBe("Java · Maven, 14 modules");
    // Nothing found (an older CLI, an empty repository): no line.
    expect(readInspection(inspect(SHOP)).lines[0]).toBe(
      "Setup will write 3 files. Nothing is committed unless you say so.",
    );
  });

  test("uncommitted changes are said, and stay", () => {
    const r = readInspection(
      fakeInspection(world({ folders: { [SHOP]: { kind: "repo", uncommitted: ["a.ts"] } } }), SHOP),
    );
    expect(r.lines).toContain("It has 1 uncommitted change. Setup leaves them as they are.");
  });

  test("set up already: add and open, nothing written", () => {
    const r = readInspection(inspect("/home/you/done"));
    expect([r.kind, r.action]).toEqual(["set-up", "Add and open"]);
  });

  test("not a git repository offers git init, as a click", () => {
    const r = readInspection(inspect("/home/you/notes"));
    expect([r.kind, r.action]).toEqual(["not-repo", "Make it a git repository"]);
  });

  test("a missing folder and a newer config offer no action; the newer one names the app's version", () => {
    expect(readInspection(inspect("/nowhere")).kind).toBe("missing");
    expect(readInspection(inspect("/nowhere")).action).toBeUndefined();
    const newer = readInspection(inspect("/home/you/new"));
    expect(newer.kind).toBe("too-new");
    expect(newer.action).toBeUndefined();
    expect(newer.lines[0]).toContain("Update the app");
  });

  test("without git nothing else matters: install git, then Retry", () => {
    const r = readInspection(inspect(SHOP, { git: false }));
    expect([r.kind, r.action]).toEqual(["no-git", undefined]);
  });

  test("with no host installed setup cannot be offered", () => {
    const r = readInspection(inspect(SHOP, { hosts: [] }));
    expect([r.kind, r.action]).toEqual(["no-host", undefined]);
  });

  test("a worktree is its repository's: the app adds the main checkout", () => {
    const i = inspect("/home/you/shop-fix");
    expect(readInspection(i).lines[0]).toBe(`A worktree of ${SHOP}: the app adds that repository.`);
  });

  test("a folder of repositories counts the ones not set up", () => {
    const r = readInspection(inspect("/home/you/work"));
    expect(r.kind).toBe("folder");
    expect(r.title).toBe("A folder of 2 repositories");
    expect(r.lines[0]).toBe("1 of them is not set up yet. Set up the ones you want, then add the folder.");
    expect(r.action).toBe("Add the folder");
  });

  test("a known repository is opened, not set up again; a folder is known by its own path", () => {
    const known: KnownRepo[] = [{ path: SHOP, name: "shop", kind: "repo", addedAt: "" }];
    expect(alreadyAdded(known, inspect("/home/you/shop-fix"))?.path).toBe(SHOP);
    expect(alreadyAdded(known, inspect("/home/you/done"))).toBeUndefined();
    expect(alreadyAdded(undefined, inspect(SHOP))).toBeUndefined();
  });
});

describe("what MetatorAI needs, and the hosts to choose from", () => {
  test("git and an installed, logged-in host: ready; no links for what is there", () => {
    const rs = requirements(inspect(SHOP));
    expect(rs.map((r) => [r.id, r.ok])).toEqual([
      ["git", true],
      ["claude", true],
    ]);
    expect(ready(rs)).toBe(true);
  });

  test("no host at all: each host is missing with its install page; one is enough", () => {
    const rs = requirements(inspect(SHOP, { hosts: [] }));
    expect(rs.map((r) => [r.id, r.ok, r.problem])).toEqual([
      ["git", true, ""],
      ["copilot", false, "not installed"],
      ["claude", false, "not installed"],
    ]);
    expect(rs[2]?.link).toContain("claude-code");
    expect(ready(rs)).toBe(false);
  });

  test("a host with no login is not ready, and says what to type", () => {
    const rs = requirements(inspect(SHOP, { hosts: [{ id: "claude", installed: true, loggedIn: false }] }));
    expect(rs[1]).toMatchObject({ ok: false, problem: "not logged in: run claude, then /login", link: "" });
    expect(ready(rs)).toBe(false);
  });

  test("git missing is not ready whatever the hosts", () => {
    const rs = requirements(inspect(SHOP, { git: false }));
    expect(rs[0]).toMatchObject({ id: "git", ok: false, link: "https://git-scm.com/downloads" });
    expect(ready(rs)).toBe(false);
  });

  test("only installed hosts can be chosen; the default is the first installed in the order", () => {
    const i = inspect(SHOP, {
      hosts: [
        { id: "copilot", installed: false },
        { id: "claude", installed: true },
      ],
    });
    expect(hostChoices(i).map((h) => [h.id, h.enabled, h.note])).toEqual([
      ["copilot", false, "not installed"],
      ["claude", true, ""],
    ]);
    expect(defaultHost(i)).toBe("claude");
    const both = inspect(SHOP, {
      hosts: [
        { id: "copilot", installed: true },
        { id: "claude", installed: true },
      ],
    });
    expect(defaultHost(both)).toBe("copilot");
    expect(defaultHost(inspect(SHOP, { hosts: [] }))).toBeUndefined();
  });

  test("the files setup writes are the chosen host's", () => {
    const i = { writes: { claude: ["a"], copilot: ["b", "c"] } };
    expect(writesFor(i, "copilot")).toEqual(["b", "c"]);
    expect(writesFor(i, undefined)).toEqual([]);
  });
});

describe("the Add repository flow", () => {
  test("pick → inspect → set up (lines) → commit card → Commit → ready → open", () => {
    const i = inspect(SHOP);
    let s = run([
      { type: "type", path: ` ${SHOP} ` },
      { type: "inspect", path: ` ${SHOP} ` },
    ]);
    expect(s).toEqual({ step: "inspecting", path: SHOP });
    s = run([{ type: "inspected", inspection: i }], s);
    expect(s).toMatchObject({ step: "inspected", host: "claude" });
    s = run([{ type: "setup" }], s);
    expect(s).toMatchObject({ step: "setting-up", target: SHOP, host: "claude", lines: [] });
    s = run(
      [
        { type: "line", line: "Wrote metator.config.yml" },
        { type: "line", line: "Wrote 2 agents" },
      ],
      s,
    );
    expect(s.step === "setting-up" && s.lines).toEqual(["Wrote metator.config.yml", "Wrote 2 agents"]);
    s = run([{ type: "setup-done", written: FILES }], s);
    expect(s).toMatchObject({ step: "set-up", written: FILES });
    s = run([{ type: "commit" }], s);
    expect(s.step).toBe("committing");
    s = run([{ type: "committed", commit: "abc1234ff" }], s);
    expect(s).toEqual({ step: "ready", path: SHOP, commit: "abc1234ff" });
    s = run([{ type: "open" }, { type: "opened" }], s);
    expect(s).toEqual({ step: "open", path: SHOP });
  });

  test("Not now keeps the files uncommitted and says how many", () => {
    const s = run([
      { type: "inspect", path: SHOP },
      { type: "inspected", inspection: inspect(SHOP) },
      { type: "setup" },
      { type: "setup-done", written: FILES },
      { type: "not-now" },
    ]);
    expect(s).toEqual({ step: "ready", path: SHOP, uncommitted: 3 });
  });

  test("a setup that wrote nothing asks no commit question", () => {
    const s = run([
      { type: "inspect", path: SHOP },
      { type: "inspected", inspection: inspect(SHOP) },
      { type: "setup" },
      { type: "setup-done", written: [] },
    ]);
    expect(s.step).toBe("ready");
  });

  test("only an installed host can be chosen", () => {
    const at = run([
      { type: "inspect", path: SHOP },
      { type: "inspected", inspection: inspect(SHOP) },
    ]);
    expect(run([{ type: "host", host: "copilot" }], at)).toBe(at);
    const both = run([
      { type: "inspect", path: SHOP },
      {
        type: "inspected",
        inspection: inspect(SHOP, {
          hosts: [
            { id: "copilot", installed: true },
            { id: "claude", installed: true },
          ],
        }),
      },
      { type: "host", host: "claude" },
    ]);
    expect(both).toMatchObject({ host: "claude" });
  });

  test("Set up is refused where there is nothing to set up, or no host", () => {
    for (const path of ["/home/you/done", "/home/you/notes", "/home/you/new"]) {
      const at = run([
        { type: "inspect", path },
        { type: "inspected", inspection: inspect(path) },
      ]);
      expect(run([{ type: "setup" }], at)).toBe(at);
    }
    const noHost = run([
      { type: "inspect", path: SHOP },
      { type: "inspected", inspection: inspect(SHOP, { hosts: [] }) },
    ]);
    expect(run([{ type: "setup" }], noHost)).toBe(noHost);
  });

  test("git init only for a folder that is not a repository; then it is inspected again", () => {
    const notes = run([
      { type: "inspect", path: "/home/you/notes" },
      { type: "inspected", inspection: inspect("/home/you/notes") },
      { type: "git-init" },
    ]);
    expect(notes.step).toBe("initializing");
    const after = run([{ type: "inspected", inspection: inspect(SHOP) }], notes);
    expect(after.step).toBe("inspected");
    const repo = run([
      { type: "inspect", path: SHOP },
      { type: "inspected", inspection: inspect(SHOP) },
    ]);
    expect(run([{ type: "git-init" }], repo)).toBe(repo);
  });

  test("an already set-up repository is opened at its main checkout; a folder at its own path", () => {
    const done = run([
      { type: "inspect", path: "/home/you/done" },
      { type: "inspected", inspection: inspect("/home/you/done") },
      { type: "open" },
    ]);
    expect(done).toEqual({ step: "opening", path: "/home/you/done" });
    const folder = run([
      { type: "inspect", path: "/home/you/work" },
      { type: "inspected", inspection: inspect("/home/you/work") },
      { type: "open" },
    ]);
    expect(folder).toEqual({ step: "opening", path: "/home/you/work" });
    const notSetUp = run([
      { type: "inspect", path: SHOP },
      { type: "inspected", inspection: inspect(SHOP) },
    ]);
    expect(run([{ type: "open" }], notSetUp)).toBe(notSetUp);
  });

  test("a folder: setup per repository not set up, then the folder is inspected again", () => {
    const at = run([
      { type: "inspect", path: "/home/you/work" },
      { type: "inspected", inspection: inspect("/home/you/work") },
    ]);
    expect(run([{ type: "setup", target: "/home/you/work/a" }], at)).toBe(at);
    expect(run([{ type: "setup" }], at)).toBe(at);
    const s = run(
      [
        { type: "setup", target: "/home/you/work/b" },
        { type: "setup-done", written: ["metator.config.yml"] },
      ],
      at,
    );
    expect(s).toMatchObject({ step: "set-up", target: "/home/you/work/b" });
    expect(run([{ type: "commit" }, { type: "committed", commit: "c" }], s)).toEqual({
      step: "inspecting",
      path: "/home/you/work",
    });
    expect(run([{ type: "not-now" }], s)).toEqual({ step: "inspecting", path: "/home/you/work" });
  });

  test("a failure returns to the step it came from, with its words; setup's output is kept", () => {
    expect(
      run([
        { type: "inspect", path: "/x" },
        { type: "failed", error: "no CLI" },
      ]),
    ).toEqual({
      step: "pick",
      path: "/x",
      error: "no CLI",
    });
    const failed = run([
      { type: "inspect", path: SHOP },
      { type: "inspected", inspection: inspect(SHOP) },
      { type: "setup" },
      { type: "line", line: "boom" },
      { type: "failed", error: "setup exited 1" },
    ]);
    expect(failed).toMatchObject({
      step: "inspected",
      lines: ["boom"],
      error: "setup exited 1",
      host: "claude",
    });
    const commit = run([
      { type: "inspect", path: SHOP },
      { type: "inspected", inspection: inspect(SHOP) },
      { type: "setup" },
      { type: "setup-done", written: FILES },
      { type: "commit" },
      { type: "failed", error: "hook refused" },
    ]);
    expect(commit).toMatchObject({ step: "set-up", error: "hook refused", written: FILES });
    const open = run([{ type: "open" }, { type: "failed", error: "no daemon" }], {
      step: "ready",
      path: SHOP,
    });
    expect(open).toEqual({ step: "ready", path: SHOP, error: "no daemon" });
  });

  test("a busy step takes no new act; an empty path is not inspected; Change goes back to the path", () => {
    expect(run([{ type: "inspect", path: "  " }])).toBe(START);
    const busy: Flow = { step: "inspecting", path: SHOP };
    for (const e of [
      { type: "inspect", path: "/y" },
      { type: "setup" },
      { type: "commit" },
      { type: "open" },
      { type: "back" },
      { type: "line", line: "x" },
      { type: "type", path: "z" },
    ] as FlowEvent[])
      expect(flowStep(busy, e)).toBe(busy);
    const at = run([
      { type: "inspect", path: SHOP },
      { type: "inspected", inspection: inspect(SHOP) },
      { type: "back" },
    ]);
    expect(at).toEqual({ step: "pick", path: SHOP });
  });

  test("the folder each step is about", () => {
    expect(
      pathOf({
        step: "setting-up",
        inspection: inspect("/home/you/work"),
        target: "/w/b",
        host: "claude",
        lines: [],
      }),
    ).toBe("/w/b");
    expect(pathOf({ step: "inspected", inspection: inspect(SHOP), host: undefined })).toBe(SHOP);
    expect(pathOf({ step: "opening", path: "/o" })).toBe("/o");
  });

  test("setup's progress is its last line with words; the commit card asks with the count", () => {
    expect(progressLine([])).toBe("Starting setup…");
    expect(progressLine(["one", "  two  ", "", "   "])).toBe("two");
    expect(commitQuestion(FILES)).toBe("Setup wrote 3 files. Commit them?");
    expect(commitQuestion(["a"])).toBe("Setup wrote 1 file. Commit them?");
    expect(shortSha("4f2c9e1d7a3b")).toBe("4f2c9e1");
  });
});

describe("the repository switcher and what the shell shows", () => {
  const known: KnownRepo[] = [
    { path: "/r/shop", name: "shop", kind: "repo", addedAt: "1" },
    { path: "/r/work", name: "work", kind: "folder", addedAt: "2" },
    { path: "/r/api", name: "api", kind: "repo", addedAt: "3" },
  ];

  test("rows by name, the open one marked, a folder says so", () => {
    expect(switcherRows(known, "/r/work").map((r) => [r.name, r.current, r.note])).toEqual([
      ["api", false, ""],
      ["shop", false, ""],
      ["work", true, "folder"],
    ]);
  });

  test("the top bar names the open repository; a folder with what its daemon serves", () => {
    expect(switcherLabel(known[0], "this repository")).toBe("shop");
    expect(switcherLabel(known[1], "3 repositories")).toBe("work · 3 repositories");
    expect(switcherLabel(undefined, "2 repositories")).toBe("2 repositories");
  });

  test("the remembered repository opens when the app still knows it, else the first added", () => {
    expect(currentRepo(known, "/r/api")?.name).toBe("api");
    expect(currentRepo(known, "/gone")?.name).toBe("shop");
    expect(currentRepo([], "/r/api")).toBeUndefined();
  });

  test("removing the open one opens another; the last one leaves the first run; another stays", () => {
    expect(afterRemove(known, "/r/shop", "/r/shop")).toEqual({ open: known[1], stay: false });
    expect(afterRemove(known, "/r/api", "/r/shop")).toEqual({ open: undefined, stay: true });
    expect(afterRemove([known[0] as KnownRepo], "/r/shop", "/r/shop")).toEqual({
      open: undefined,
      stay: false,
    });
  });

  test("the first run only in the app's shell with no repository; Add and the app's settings stand alone", () => {
    expect(shellView({ commands: true, known: [], down: true, screen: "inbox" })).toBe("first-run");
    expect(shellView({ commands: true, known: undefined, down: true, screen: "inbox" })).toBe("no-daemon");
    expect(shellView({ commands: false, known: undefined, down: true, screen: "inbox" })).toBe("no-daemon");
    expect(shellView({ commands: true, known, down: false, screen: "inbox" })).toBe("screens");
    expect(shellView({ commands: true, known: [], down: true, screen: "add" })).toBe("add");
    expect(shellView({ commands: false, known: undefined, down: true, screen: "app" })).toBe("app-settings");
  });

  test("the web build's commands, with the path quoted when it needs it", () => {
    expect(webCommands("/home/you/my shop", "copilot")).toEqual([
      'cd "/home/you/my shop"',
      "metator inspect .",
      "metator setup --host copilot --yes",
      "metator setup --commit --files <the files setup listed>",
      "metator serve",
    ]);
    expect(webCommands("", "claude")[0]).toBe("cd /path/to/your/repository");
    expect(shellPath('/a/"b"$')).toBe('"/a/\\"b\\"\\$"');
    expect(shellPath("/plain/path-1.2")).toBe("/plain/path-1.2");
  });

  test("Settings' words: the CLI's source, and what installing the command did", () => {
    expect(cliSourceText({ source: "bundled" })).toBe("Bundled with the app");
    expect(cliSourceText({ source: "path" })).toBe("The metator on your PATH");
    expect(cliSourceText({ source: "custom" })).toBe("A metator you chose");
    expect(installedText({ path: "/home/you/.local/bin/metator", onPath: true })).toBe(
      "Wrote /home/you/.local/bin/metator. A new terminal finds metator.",
    );
    expect(installedText({ path: "/home/you/.local/bin/metator", onPath: false })).toContain(
      "add /home/you/.local/bin to it",
    );
  });
});

describe("the shell's commands: the Tauri wrapper and its fake", () => {
  test("each command is invoked by its name with camelCase arguments; a refusal is { code, message, hint }", async () => {
    const calls: [string, unknown][] = [];
    const c = tauriCommands(
      async (command, args) => {
        calls.push([command, args]);
        if (command === "open_repo")
          throw { code: "NO_CLI", message: "no metator", hint: "reinstall the app" };
        if (command === "git_init") throw "plain words";
        return command === "run_setup" ? { runId: "r1" } : null;
      },
      async () => () => undefined,
    );
    await c.inspectFolder("/p");
    await c.runSetup("/p", "claude");
    await c.commitSetup("/p", ["a", "b"]);
    await c.setCliSource("bundled");
    await c.setCliSource("custom", "/bin/m");
    expect(calls).toEqual([
      ["inspect_folder", { path: "/p" }],
      ["run_setup", { path: "/p", host: "claude" }],
      ["commit_setup", { path: "/p", files: ["a", "b"] }],
      ["set_cli_source", { source: "bundled" }],
      ["set_cli_source", { source: "custom", path: "/bin/m" }],
    ]);
    const refused = await c.openRepo("/p").catch((e: unknown) => e);
    expect(refused).toEqual({ code: "NO_CLI", message: "no metator", hint: "reinstall the app" });
    expect(errorText(refused)).toBe("no metator. reinstall the app");
    expect(await c.gitInit("/p").catch((e: unknown) => e)).toEqual({
      code: "FAILED",
      message: "plain words",
    });
    expect(asCommandError(undefined).message).toBe("the app's shell did not answer");
  });

  test("setup's events come through listen: output and done, each one stopped after", async () => {
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    const stopped: string[] = [];
    const c = tauriCommands(
      async () => null,
      async (name, h) => {
        handlers.set(name, h);
        return () => stopped.push(name);
      },
    );
    const seen: SetupEvent[] = [];
    const stop = await c.onSetup((e) => seen.push(e));
    handlers.get("setup://output")?.({ payload: { runId: "r", line: "hi" } });
    handlers.get("setup://done")?.({ payload: { runId: "r", ok: true, written: ["a"] } });
    stop();
    expect(seen).toEqual([
      { kind: "output", runId: "r", line: "hi" },
      { kind: "done", runId: "r", ok: true, written: ["a"] },
    ]);
    expect(stopped.sort()).toEqual(["setup://done", "setup://output"]);
  });

  test("setup with output: no line is lost before the run's id is known; another run's lines are not mine", async () => {
    let listener: (e: SetupEvent) => void = () => undefined;
    let stopped = false;
    const lines: string[] = [];
    const done = await setupWithOutput(
      {
        onSetup: async (l) => {
          listener = l;
          return () => {
            stopped = true;
          };
        },
        runSetup: async () => {
          // Tauri may deliver a line before invoke resolves.
          listener({ kind: "output", runId: "mine", line: "early" });
          listener({ kind: "output", runId: "other", line: "not mine" });
          setTimeout(() => {
            listener({ kind: "output", runId: "mine", line: "late" });
            listener({ kind: "done", runId: "other", ok: false, written: [] });
            listener({ kind: "done", runId: "mine", ok: true, written: ["f"] });
          }, 1);
          return { runId: "mine" };
        },
      },
      "/p",
      "claude",
      (l) => lines.push(l),
    );
    expect(lines).toEqual(["early", "late"]);
    expect(done).toEqual({ kind: "done", runId: "mine", ok: true, written: ["f"] } as never);
    expect(stopped).toBe(true);
  });

  test("the fake runs the whole flow and keeps what changed", async () => {
    const w = world({ setupLines: ["one", "two"], lineMs: 1 });
    const c = fakeCommands(w, {});
    const lines: string[] = [];
    const done = await setupWithOutput(c, SHOP, "claude", (l) => lines.push(l));
    expect([done.ok, done.written, lines]).toEqual([true, [...FILES].sort(), ["one", "two"]]);
    expect((await c.inspectFolder(SHOP)).next).toBe("add");
    expect((await c.commitSetup(SHOP, done.written)).commit).toHaveLength(40);
    expect(await c.commitSetup(SHOP, []).catch((e: unknown) => asCommandError(e).code)).toBe("USAGE");
    await c.gitInit("/home/you/notes");
    expect((await c.inspectFolder("/home/you/notes")).next).toBe("setup");
    expect((await c.addRepo(SHOP)).name).toBe("shop");
    expect((await c.addRepo(SHOP)).name).toBe("shop");
    await c.addRepo("/home/you/work");
    expect((await c.knownRepos()).map((k) => [k.name, k.kind])).toEqual([
      ["shop", "repo"],
      ["work", "folder"],
    ]);
    await c.removeRepo(SHOP);
    expect((await c.knownRepos()).map((k) => k.name)).toEqual(["work"]);
    expect(w.calls?.filter((x) => x.command === "commit_setup")[0]?.args).toEqual([SHOP, [...FILES].sort()]);
  });

  test("the fake fails setup and open when its world says so, and installs the command", async () => {
    const w = world({ setupError: "exit 1", openError: "no daemon" });
    const c = fakeCommands(w, {});
    const done = await setupWithOutput(c, SHOP, "claude", () => undefined);
    expect([done.ok, done.error?.message]).toEqual([false, "exit 1"]);
    expect(await c.openRepo(SHOP).catch((e: unknown) => errorText(e))).toBe("no daemon");
    expect(await c.installCliCommand()).toEqual({ path: "/home/you/.local/bin/metator", onPath: true });
    expect(await c.uninstallCliCommand()).toEqual({ path: "/home/you/.local/bin/metator" });
    expect(await c.uninstallCliCommand()).toEqual({ path: null });
    expect((await c.setCliSource("path")).path).toBe("/usr/local/bin/metator");
    expect(await c.setCliSource("custom").catch((e: unknown) => asCommandError(e).code)).toBe("USAGE");
  });

  test("the window's commands: the e2e's fake first, then Tauri's, none in a browser; one per window", () => {
    expect(appCommands({})).toBeUndefined();
    expect(appCommands(undefined)).toBeUndefined();
    const tauri = { __TAURI__: { core: { invoke: async () => null } } };
    expect(appCommands(tauri)).toBeDefined();
    expect(appCommands(tauri)).toBe(appCommands(tauri));
    const fake = { __METATOR_FAKE__: world(), __TAURI__: tauri.__TAURI__ } as Record<string, unknown>;
    expect(appCommands(fake)).toBeDefined();
    expect(fake.__METATOR_FAKE_CONTROL__).toBeDefined();
  });
});
