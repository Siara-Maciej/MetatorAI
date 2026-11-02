/**
 * `metator doctor` end to end (P2): on a real repository the CLI says what a run will not do
 * (no dependencies installed, no gates, no remote) and `run init` carries the same warnings, so
 * nobody learns it from a run whose gates checked only rules.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: build
    owner: mt-implementer
`;

let repo: ScratchRepo;
const mt = (...args: string[]) => metator(args, repo.root);
interface Check {
  id: string;
  status: string;
  fix?: string;
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nnode_modules/\n");
  await repo.write("package.json", '{ "name": "demo", "scripts": { "test": "bun test" } }\n');
  await repo.write("bun.lock", "{}\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.commit("init");
});
afterAll(async () => repo.dispose());

describe("metator doctor (real CLI)", () => {
  test("a repository without dependencies, gates or a remote: ready, with what a run will not do", async () => {
    const r = await mt("doctor");
    expect(r.code).toBe(0);
    const data = r.json.data as { ready: boolean; checks: Check[] };
    expect(data.ready).toBe(true);
    expect(data.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      "config:warn",
      "canon:warn",
      "workflows:ok",
      "gates:warn",
      "dependencies:warn",
      "remote:warn",
    ]);
    expect(data.checks.find((c) => c.id === "dependencies")?.fix).toBe("bun install");
    expect((r.json.warnings as string[]).length).toBe(5);
  });

  test("run init warns about an open question in the task and what this run cannot do; installed dependencies end that warning", async () => {
    const init = await mt(
      "run",
      "init",
      "--workflow",
      "demo",
      "--task",
      "Add a --verbose flag to the CLI. Should it also log timings?",
    );
    expect(init.code).toBe(0);
    expect((init.json.warnings as string[]).map((w) => w.split(":")[0])).toEqual([
      "task",
      "gates",
      "dependencies",
      "remote",
    ]);
    expect((init.json.warnings as string[])[0]).toContain("(Should it also log timings?)");
    await mkdir(repo.path("node_modules"));
    const after = await mt("doctor");
    const deps = (after.json.data as { checks: Check[] }).checks.find((c) => c.id === "dependencies");
    expect(deps?.status).toBe("ok");
  });

  test("without any workflow the repository is not ready", async () => {
    const empty = await ScratchRepo.create();
    try {
      await empty.write("README.md", "# x\n");
      await empty.commit("init");
      const r = await metator(["doctor"], empty.root);
      expect((r.json.data as { ready: boolean }).ready).toBe(false);
    } finally {
      await empty.dispose();
    }
  });
});
