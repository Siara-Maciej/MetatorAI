/**
 * Linked runs end to end (F7.6): a folder of three real repositories. The platform repository
 * holds the map and the system run (W13); billing and web are checkouts set in `system.roots`.
 * An approved plan starts its first wave as a child run in billing, linked both ways; web waits
 * until billing's run is done; `system status` reads the children back and finishes the plan.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";

const MAP = `kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - { id: billing, kind: service, source: { repo: github.com/shop/billing }, owners: ["@billing-team"] }
  - { id: web, kind: frontend, source: { repo: github.com/shop/web }, owners: ["@web-team"], consumes: [billing-api] }
contracts:
  - { id: billing-api, kind: openapi, owner: billing, spec: { path: openapi.yaml } }
policies: { breaking: versioned }
`;
// A one-stage workflow for the child runs, so the test can finish them with one event.
const TINY =
  "kind: Workflow\nschemaVersion: 2\nid: mt-tiny\nstages:\n  - id: build\n    owner: mt-implementer\n";
const CONFIG =
  "kind: MetatorConfig\nschemaVersion: 4\nsystem:\n  roots: { billing: ../billing, web: ../web }\n";

let folder: string;
const at = (name: string) => join(folder, name);
const git = (dir: string, ...a: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...a], {
    cwd: dir,
  });
const env = { METATOR_USER: "ana" };
const mt = (repo: string, ...args: string[]) => metator(args, at(repo), env);

interface Step {
  id: string;
  status: string;
  run?: string;
  runStatus?: string;
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "metator-linked-"));
  const W13 = await Bun.file(
    join(import.meta.dir, "..", ".github/metator/workflows/mt-system-change.yml"),
  ).text();
  const repo = async (name: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) await Bun.write(join(at(name), p), t);
    git(at(name), "init", "-q", "-b", "main");
    git(at(name), "add", "-A");
    git(at(name), "commit", "-q", "-m", "init");
  };
  await repo("platform", {
    "docs/metator/system.yml": MAP,
    "metator.config.yml": CONFIG,
    ".github/metator/workflows/mt-system-change.yml": W13,
    ".gitignore": ".metator/\n",
  });
  for (const name of ["billing", "web"])
    await repo(name, {
      "src/main.ts": "export const m = 1;\n",
      ".github/metator/workflows/mt-tiny.yml": TINY,
      ".gitignore": ".metator/\n",
    });
});
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe("linked runs (real CLI, three repositories)", () => {
  let parent: string;

  test("a W13 system run starts the first wave as a child run in billing, linked both ways", async () => {
    const plan = await mt("platform", "system", "plan", "new", "Rename refunds", "--breaking", "billing-api");
    expect((plan.json.data as { steps: { id: string }[] }).steps.map((s) => s.id)).toEqual([
      "billing-bump",
      "web-migrate",
    ]);
    const early = await mt("platform", "system", "plan", "run", "rename-refunds");
    expect((early.json.error as { message: string }).message).toBe("rename-refunds is not approved");
    expect((await mt("platform", "system", "plan", "approve", "rename-refunds")).code).toBe(0);

    const system = await mt(
      "platform",
      "run",
      "init",
      "--workflow",
      "mt-system-change",
      "--task",
      "Rename refunds",
    );
    parent = (system.json.data as { runId: string }).runId;
    const started = await mt(
      "platform",
      "system",
      "plan",
      "run",
      "--run",
      `.metator/runs/${parent}`,
      "--workflow",
      "mt-tiny",
    );
    expect(started.code).toBe(0);
    const first = (
      started.json.data as {
        started: { step: string; app: string; root: string; run: string; task: string }[];
      }
    ).started;
    expect(first.map((s) => [s.step, s.app, s.root])).toEqual([["billing-bump", "billing", at("billing")]]);
    expect(first[0]?.task).toStartWith(
      "Release a new major version of billing-api (system plan rename-refunds, step billing-bump in billing",
    );

    const child = JSON.parse(
      await Bun.file(join(at("billing"), ".metator/runs", first[0]?.run as string, "state.json")).text(),
    );
    expect([child.schemaVersion, child.parent, child.system]).toEqual([
      4,
      parent,
      { plan: "rename-refunds", step: "billing-bump", app: "billing" },
    ]);
    const record = JSON.parse(
      await Bun.file(join(at("platform"), ".metator/runs", parent, "state.json")).text(),
    );
    expect(record.children).toEqual([first[0]?.run]);

    const waiting = await mt("platform", "system", "plan", "run", "rename-refunds", "--workflow", "mt-tiny");
    expect([(waiting.json.data as { started: unknown[] }).started, waiting.json.warnings]).toEqual([
      [],
      ["no step can start yet: the steps before them are not done (`metator system status`)"],
    ]);
    const check = await mt("platform", "system", "status", "--run", parent, "--check");
    expect([check.code, (check.json.error as { message: string }).message]).toEqual([
      1,
      "2 step(s) of rename-refunds are not done",
    ]);
  }, 120_000);

  test("billing's run done: status reads it back, web starts, and the plan finishes", async () => {
    const billing = (await mt("platform", "system", "status", "rename-refunds")).json.data as {
      steps: Step[];
    };
    const run = billing.steps[0]?.run as string;
    expect((await mt("billing", "run", "advance", "pass", "--run", run)).code).toBe(0);
    const read = (await mt("platform", "system", "status", "rename-refunds")).json.data as { steps: Step[] };
    expect(read.steps.map((s) => [s.id, s.status, s.runStatus])).toEqual([
      ["billing-bump", "done", "done"],
      ["web-migrate", "pending", undefined],
    ]);
    const next = await mt("platform", "system", "plan", "run", "--run", parent, "--workflow", "mt-tiny");
    const web = (next.json.data as { started: { step: string; root: string; run: string }[] }).started;
    expect(web.map((s) => [s.step, s.root])).toEqual([["web-migrate", at("web")]]);
    expect((await mt("web", "run", "advance", "pass", "--run", web[0]?.run as string)).code).toBe(0);
    const done = await mt("platform", "system", "status", "--run", parent, "--check");
    expect(done.code).toBe(0);
    expect((done.json.data as { plan: { status: string } }).plan.status).toBe("done");
    const record = JSON.parse(
      await Bun.file(join(at("platform"), ".metator/runs", parent, "state.json")).text(),
    );
    expect(record.children).toHaveLength(2);
  }, 120_000);

  test("a step whose application has no checkout here cannot start", async () => {
    await Bun.write(join(at("platform"), "metator.config.yml"), "kind: MetatorConfig\nschemaVersion: 4\n");
    expect(
      (await mt("platform", "system", "plan", "new", "Add credits", "--contracts", "billing-api")).code,
    ).toBe(0);
    expect((await mt("platform", "system", "plan", "approve", "add-credits")).code).toBe(0);
    const r = await mt("platform", "system", "plan", "run", "add-credits");
    expect((r.json.error as { message: string }).message).toBe(
      "no checkout of billing to run step billing-change in",
    );
  }, 90_000);
});
