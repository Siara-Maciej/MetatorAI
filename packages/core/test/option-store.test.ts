import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  DEFAULT_PATHS,
  InitRun,
  MetatorConfigDocument,
  MetatorConfigSchema,
  OptionStore,
  RunRepository,
  USER_OPTIONS_FILE,
  WorkflowCatalog,
} from "@metator/core";
import { FixedClock, InMemoryFileSystem, InMemoryMachineState } from "@metator/testing";
import { parse } from "yaml";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

function world(files: Record<string, string> = {}) {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW, ...files });
  const user = new InMemoryMachineState();
  const runs = new RunRepository(fs, DEFAULT_PATHS);
  const configText = files["metator.config.yml"];
  const config = configText
    ? MetatorConfigDocument.parse(parse(configText), "metator.config.yml")._unsafeUnwrap()
    : DEFAULT_CONFIG;
  const store = new OptionStore({
    fs,
    user,
    config,
    configFile: configText ? "metator.config.yml" : undefined,
    runs,
  });
  const init = (task: string) =>
    new InitRun(
      new WorkflowCatalog(fs, DEFAULT_PATHS),
      runs,
      new FixedClock(new Date("2026-11-09T10:00:00Z")),
    ).execute({
      workflow: "demo",
      task,
    });
  return { fs, user, runs, store, init };
}

describe("OptionStore", () => {
  test("every option lists with its default until a file sets it; groups count the changed ones", async () => {
    const w = world();
    const view = (await w.store.list())._unsafeUnwrap();
    expect(view.options.length).toBeGreaterThan(40);
    expect(view.options.every((o) => o.source === "default" || o.source === "repo")).toBe(true);
    expect(view.groups.map((g) => g.id)).toEqual([
      "editor",
      "hosts",
      "issues",
      "keys",
      "notify",
      "review",
      "supervisor",
      "terminal",
      "ui",
      "worktrees",
    ]);
    expect(view.diagnostics).toEqual([]);
    expect((await w.store.list({ changed: true }))._unsafeUnwrap().options.map((o) => o.key)).toEqual([
      // Legacy config fields count as set by the repository, with their defaults.
      "supervisor.hostOrder",
      "supervisor.idleThresholdMs",
      "supervisor.respawn",
      "supervisor.respawnAttempts",
      "supervisor.wipLimit",
    ]);
  });

  test("set at user scope writes the person's file (created with its header) and the value is read back typed", async () => {
    const w = world();
    const set = (await w.store.set({ key: "ui.paneBorders", scope: "user", text: "always" }))._unsafeUnwrap();
    expect(set).toMatchObject({ value: "always", source: "user", layers: { user: "always" } });
    const file = w.user.files.get(USER_OPTIONS_FILE) as string;
    expect(file.startsWith("# Your MetatorAI options")).toBe(true);
    expect(parse(file)).toEqual({
      kind: "UserOptions",
      schemaVersion: 2,
      options: { "ui.paneBorders": "always" },
    });
    const zoom = (
      await w.store.set({ key: "keys.zoom", scope: "user", text: "prefix+f, ctrl+z" })
    )._unsafeUnwrap();
    expect(zoom.value).toEqual(["prefix+f", "ctrl+z"]);
    expect(parse(w.user.files.get(USER_OPTIONS_FILE) as string)).toMatchObject({
      options: { "ui.paneBorders": "always", "keys.zoom": ["prefix+f", "ctrl+z"] },
    });
    const width = (await w.store.set({ key: "ui.sidebarWidth", scope: "user", value: 300 }))._unsafeUnwrap();
    expect(width.value).toBe(300);
    // Unset puts the default back and removes the key.
    const unset = (await w.store.unset({ key: "ui.paneBorders", scope: "user" }))._unsafeUnwrap();
    expect(unset).toMatchObject({ value: "auto", source: "default" });
    expect(parse(w.user.files.get(USER_OPTIONS_FILE) as string)).toMatchObject({
      options: { "keys.zoom": ["prefix+f", "ctrl+z"], "ui.sidebarWidth": 300 },
    });
  });

  test("a bad value, a fixed option, a wrong scope and an unknown key are refused with a usage error, nothing written", async () => {
    const w = world();
    const bad = await w.store.set({ key: "ui.paneBorders", scope: "user", text: "sometimes" });
    expect(bad.isErr() && bad.error.code).toBe("USAGE");
    expect(bad.isErr() && bad.error.message).toContain("ui.paneBorders");
    const fixed = await w.store.set({ key: "issues.requireConsent", scope: "repo", text: "false" });
    expect(fixed.isErr() && fixed.error.message).toContain("fixed");
    const scope = await w.store.set({ key: "ui.paneBorders", scope: "repo", text: "always" });
    expect(scope.isErr() && scope.error.message).toContain("--scope user");
    const unknown = await w.store.set({ key: "ui.nope", scope: "user", text: "1" });
    expect(unknown.isErr() && unknown.error.code).toBe("NOT_FOUND");
    expect(w.user.files.size).toBe(0);
    expect(await w.fs.exists("metator.config.yml")).toBe(false);
  });

  test("set at repo scope keeps the config's comments and other fields, bumps the version, and stays a valid config", async () => {
    const w = world({
      "metator.config.yml":
        "kind: MetatorConfig\nschemaVersion: 7\n# the editor\neditor: cursor\nsupervisor:\n  wipLimit: 3\n",
    });
    // The legacy fields show as the repository's values.
    expect((await w.store.get("editor.command"))._unsafeUnwrap()).toMatchObject({
      value: "cursor",
      source: "repo",
    });
    expect((await w.store.get("supervisor.wipLimit"))._unsafeUnwrap()).toMatchObject({
      value: 3,
      source: "repo",
    });
    const set = (await w.store.set({ key: "supervisor.wipLimit", scope: "repo", text: "2" }))._unsafeUnwrap();
    expect(set).toMatchObject({ value: 2, source: "repo", layers: { repo: 2 } });
    const text = (await w.fs.read("metator.config.yml"))._unsafeUnwrap();
    expect(text).toContain("# the editor");
    expect(text).toContain("editor: cursor");
    const doc = parse(text);
    expect(doc.schemaVersion).toBe(MetatorConfigDocument.current);
    expect(doc.options).toEqual({ "supervisor.wipLimit": 2 });
    expect(MetatorConfigDocument.parse(doc, "metator.config.yml").isOk()).toBe(true);
    // The store sees the file's map only through the loaded config: a new store with the new config resolves it.
    const reloaded = new OptionStore({
      fs: w.fs,
      user: w.user,
      config: MetatorConfigDocument.parse(doc, "metator.config.yml")._unsafeUnwrap(),
      configFile: "metator.config.yml",
    });
    expect((await reloaded.get("supervisor.wipLimit"))._unsafeUnwrap()).toMatchObject({
      value: 2,
      source: "repo",
    });
    // No config at all: a small one is created.
    const fresh = world();
    (await fresh.store.set({ key: "review.sendTo", scope: "repo", text: "worker" }))._unsafeUnwrap();
    const created = parse((await fresh.fs.read("metator.config.yml"))._unsafeUnwrap());
    expect(created).toEqual({
      kind: "MetatorConfig",
      schemaVersion: 9,
      options: { "review.sendTo": "worker" },
    });
    expect(MetatorConfigSchema.safeParse({ options: created.options }).success).toBe(true);
  });

  test("a run overrides a repo option in its record; the override needs the run and is gone with unset", async () => {
    const w = world();
    const run = (await w.init("Add discount"))._unsafeUnwrap();
    const missing = await w.store.set({ key: "supervisor.wipLimit", scope: "run", text: "1" });
    expect(missing.isErr() && missing.error.message).toContain("--run");
    const set = (
      await w.store.set({ key: "supervisor.wipLimit", scope: "run", text: "1", runId: run.runId })
    )._unsafeUnwrap();
    expect(set).toMatchObject({ value: 1, source: "run", layers: { run: 1 } });
    expect((await w.runs.load(run.runId))._unsafeUnwrap().options).toEqual({ "supervisor.wipLimit": 1 });
    // Without the run in view, the repository's value still applies.
    expect((await w.store.get("supervisor.wipLimit"))._unsafeUnwrap().value).toBe(4);
    const view = (await w.store.list({ runId: run.runId, changed: true }))._unsafeUnwrap();
    expect(view.files.run).toBe(`${run.runId}/state.json`);
    expect(view.options.find((o) => o.key === "supervisor.wipLimit")?.source).toBe("run");
    (await w.store.unset({ key: "supervisor.wipLimit", scope: "run", runId: run.runId }))._unsafeUnwrap();
    expect((await w.runs.load(run.runId))._unsafeUnwrap().options).toEqual({});
  });

  test("a user file with a wrong value, an unknown key or broken YAML is a diagnostic, never an error", async () => {
    const w = world();
    await w.user.write(
      USER_OPTIONS_FILE,
      "kind: UserOptions\nschemaVersion: 1\noptions:\n  keys.detach: ctrl+\n  ui.nope: 1\n  ui.paneBorders: always\n",
    );
    const view = (await w.store.list())._unsafeUnwrap();
    expect(view.options.find((o) => o.key === "keys.detach")).toMatchObject({
      value: ["prefix+q"],
      source: "default",
    });
    expect(view.options.find((o) => o.key === "ui.paneBorders")?.value).toBe("always");
    expect(view.diagnostics.map((d) => [d.kind, d.key])).toEqual([
      ["invalid-value", "keys.detach"],
      ["unknown-key", "ui.nope"],
    ]);
    await w.user.write(USER_OPTIONS_FILE, "options: [\n");
    const broken = (await w.store.list())._unsafeUnwrap();
    expect(broken.diagnostics).toHaveLength(1);
    expect(broken.diagnostics[0]?.message).toContain("ignored");
    expect(broken.options.find((o) => o.key === "ui.paneBorders")?.value).toBe("auto");
  });
});
