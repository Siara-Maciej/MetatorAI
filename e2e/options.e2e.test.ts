/**
 * Options end to end (S1, design/13): the real `metator config` on a real temp repository and a
 * person's own config directory. A set lands in the scope's file with its header; a wrong value
 * is refused by `set` and, when it is in a file, is a diagnostic and the default; the running
 * daemon serves the same view and writes the same files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

let repo: ScratchRepo;
let configDir: string;
let env: Record<string, string>;
type Data = Record<string, unknown>;
const mt = (...args: string[]) => metator(args, repo.root, env);
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const option = (view: Data, key: string) =>
  (view.options as { key: string; value: unknown; source: string }[]).find((o) => o.key === key);

beforeAll(async () => {
  repo = await ScratchRepo.create();
  configDir = await mkdtemp(join(tmpdir(), "metator-e2e-config-"));
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write(
    "metator.config.yml",
    "kind: MetatorConfig\nschemaVersion: 7\n# the person's editor\neditor: cursor\nsupervisor:\n  wipLimit: 3\n",
  );
  await repo.commit("init");
  env = { METATOR_CONFIG_DIR: configDir };
});
afterAll(async () => {
  await repo.dispose();
  await rm(configDir, { recursive: true, force: true });
});

describe("metator config (options, real CLI)", () => {
  test("list shows every option with its source; legacy config fields count as the repository's values", async () => {
    const view = data(await mt("config", "list"));
    expect((view.options as unknown[]).length).toBeGreaterThan(30);
    expect(option(view, "editor.command")).toMatchObject({ value: "cursor", source: "repo" });
    expect(option(view, "supervisor.wipLimit")).toMatchObject({ value: 3, source: "repo" });
    expect(option(view, "ui.paneBorders")).toMatchObject({ value: "auto", source: "default" });
    expect(view.diagnostics).toEqual([]);
    const changed = data(await mt("config", "list", "--changed"));
    expect((changed.options as { key: string }[]).map((o) => o.key)).toContain("editor.command");
    expect((changed.options as { key: string }[]).every((o) => !o.key.startsWith("ui."))).toBe(true);
    const repoOnly = data(await mt("config", "list", "--scope", "repo"));
    expect(
      (repoOnly.options as { definition: { scope: string } }[]).every((o) => o.definition.scope === "repo"),
    ).toBe(true);
  }, 30_000);

  test("set --scope user writes ~/.config/metator/options.yml with its header; get reads it back typed", async () => {
    const set = await mt("config", "set", "ui.paneBorders", "always", "--scope", "user");
    expect(set.code).toBe(0);
    expect(data(set)).toMatchObject({ key: "ui.paneBorders", value: "always", source: "user" });
    const keys = data(await mt("config", "set", "keys.zoom", "prefix+f, ctrl+z", "--scope", "user"));
    expect(keys.value).toEqual(["prefix+f", "ctrl+z"]);
    const file = parse(await readFile(join(configDir, "options.yml"), "utf8"));
    expect(file).toEqual({
      kind: "UserOptions",
      schemaVersion: 2,
      options: { "ui.paneBorders": "always", "keys.zoom": ["prefix+f", "ctrl+z"] },
    });
    expect(data(await mt("config", "get", "keys.zoom"))).toMatchObject({
      value: ["prefix+f", "ctrl+z"],
      source: "user",
      layers: { user: ["prefix+f", "ctrl+z"] },
    });
    const unset = data(await mt("config", "unset", "ui.paneBorders", "--scope", "user"));
    expect(unset).toMatchObject({ value: "auto", source: "default" });
  }, 30_000);

  test("a wrong value or scope is refused with USAGE and nothing changes; a wrong value in the file is a diagnostic", async () => {
    const bad = await mt("config", "set", "terminal.scrollbackLines", "wide", "--scope", "user");
    expect(bad.code).not.toBe(0);
    expect(bad.json.error).toMatchObject({ code: "USAGE" });
    const scope = await mt("config", "set", "ui.paneBorders", "off", "--scope", "repo");
    expect(scope.json.error).toMatchObject({ code: "USAGE" });
    expect((scope.json.error as Data).message).toContain("--scope user");
    const fixed = await mt("config", "set", "issues.requireConsent", "false", "--scope", "repo");
    expect((fixed.json.error as Data).message).toContain("fixed");
    // A hand-edited file with a wrong value: the default applies, the file says so.
    await Bun.write(
      join(configDir, "options.yml"),
      'kind: UserOptions\nschemaVersion: 1\noptions:\n  keys.zoom: [prefix+f, ctrl+z]\n  keys.help: "ctrl+"\n  ui.nope: 1\n',
    );
    const view = data(await mt("config", "list"));
    expect(option(view, "keys.help")).toMatchObject({ value: ["prefix+?"], source: "default" });
    expect((view.diagnostics as { kind: string; key: string }[]).map((d) => [d.kind, d.key])).toEqual([
      ["invalid-value", "keys.help"],
      ["unknown-key", "ui.nope"],
    ]);
  }, 30_000);

  test("set --scope repo keeps the config's comments and moves it to the current version; --scope run writes the run's record", async () => {
    const set = data(await mt("config", "set", "supervisor.wipLimit", "2", "--scope", "repo"));
    expect(set).toMatchObject({ value: 2, source: "repo", layers: { repo: 2 } });
    const text = await repo.read("metator.config.yml");
    expect(text).toContain("# the person's editor");
    expect(parse(text)).toMatchObject({
      schemaVersion: 11,
      editor: "cursor",
      options: { "supervisor.wipLimit": 2 },
    });
    expect(data(await mt("config", "show"))).toMatchObject({ source: "metator.config.yml" });
    const runId = data(await mt("run", "init", "--workflow", "demo", "--task", "Add the discount"))
      .runId as string;
    const run = data(await mt("config", "set", "supervisor.wipLimit", "1", "--scope", "run", "--run", runId));
    expect(run).toMatchObject({ value: 1, source: "run", layers: { repo: 2, run: 1 } });
    expect(data(await mt("config", "get", "supervisor.wipLimit"))).toMatchObject({
      value: 2,
      source: "repo",
    });
    const record = JSON.parse(await repo.read(`.metator/runs/${runId}/state.json`));
    expect(record).toMatchObject({ schemaVersion: 7, options: { "supervisor.wipLimit": 1 } });
    const schema = data(await mt("config", "schema", "--options")) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain("supervisor.wipLimit");
  }, 30_000);

  test("the daemon serves the same view and writes the same files", async () => {
    const daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100"], {
      cwd: repo.root,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const call = async (path: string, init?: RequestInit) => {
      const r = await fetch(`${base}${path}`, init);
      const text = await r.text();
      try {
        return JSON.parse(text) as { ok: boolean; data: Data; error: Data };
      } catch {
        throw new Error(`${path}: HTTP ${r.status}: ${text.slice(0, 400)}`);
      }
    };
    let base = "";
    try {
      const reader = daemon.stderr.getReader();
      let text = "";
      const deadline = Date.now() + 20_000;
      while (!base && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        const line = text.split("\n").find((l) => l.includes('"serving"'));
        if (line) base = (JSON.parse(line) as { serving: { url: string } }).serving.url;
      }
      expect(base).not.toBe("");
      const view = await call("/options");
      expect(view.ok).toBe(true);
      expect(option(view.data, "supervisor.wipLimit")).toMatchObject({ value: 2, source: "repo" });
      // The option is what the supervisor runs with, not only what the list shows.
      const supervisor = await call("/supervisor");
      expect((supervisor.data.policy as Data).wipLimit).toBe(2);
      const set = await call("/options/ui.paneBorders", {
        method: "POST",
        body: JSON.stringify({ scope: "user", value: "always" }),
        headers: { "content-type": "application/json" },
      });
      expect(set.data).toMatchObject({ key: "ui.paneBorders", value: "always", source: "user" });
      expect(parse(await readFile(join(configDir, "options.yml"), "utf8"))).toMatchObject({
        options: { "ui.paneBorders": "always" },
      });
      const refused = await call("/options/ui.paneBorders", {
        method: "POST",
        body: JSON.stringify({ scope: "user", value: "loose" }),
        headers: { "content-type": "application/json" },
      });
      expect(refused.ok).toBe(false);
      expect(refused.error.code).toBe("USAGE");
      const reset = await call("/options/ui.paneBorders", {
        method: "POST",
        body: JSON.stringify({ scope: "user", reset: true }),
        headers: { "content-type": "application/json" },
      });
      expect(reset.data).toMatchObject({ value: "auto", source: "default" });
      // The CLI sees what the daemon wrote.
      expect(data(await mt("config", "get", "ui.paneBorders"))).toMatchObject({ source: "default" });
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
  }, 60_000);
});
