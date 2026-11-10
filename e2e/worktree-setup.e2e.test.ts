/**
 * A session's checkout made ready (P9), end to end: `run init --worktree` copies the main
 * checkout's node_modules into the run's worktree when the lockfiles are the same, `doctor --run`
 * looks at that worktree, and `--no-setup` leaves it for `worktree setup` later.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
interface Check {
  id: string;
  status: string;
  fix?: string;
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nnode_modules/\n");
  await repo.write("package.json", '{ "name": "demo", "private": true }\n');
  await repo.write("bun.lock", '{ "lockfileVersion": 1, "workspaces": {} }\n');
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.commit("init");
  // The main checkout has its dependencies: a marker stands in for them.
  await mkdir(repo.path("node_modules/.bin"), { recursive: true });
  await repo.write("node_modules/.marker", "installed here\n");
});
afterAll(async () => repo.dispose());

describe("worktree setup (real CLI)", () => {
  test("run init --worktree gives the worktree the main checkout's dependencies; doctor --run sees them", async () => {
    const init = await mt(
      "run",
      "init",
      "--workflow",
      "demo",
      "--task",
      "Add the first flag to the CLI",
      "--worktree",
    );
    expect(init.code).toBe(0);
    const d = data(init);
    const setup = d.setup as { dependencies: string; detail: string };
    expect([setup.dependencies, setup.detail]).toEqual(["reused", "node_modules"]);
    const wt = (d.worktree as { id: string; path: string }).path;
    expect(await repo.read(`${wt}/node_modules/.marker`)).toBe("installed here\n");
    // The run's warnings are about its worktree: dependencies are there, so none about them.
    expect((init.json.warnings as string[]).some((w) => w.startsWith("dependencies"))).toBe(false);

    const doctor = await mt("doctor", "--run", d.runId as string);
    const checks = (data(doctor) as { place: string; checks: Check[] }).checks;
    expect((data(doctor) as { place: string }).place).toBe(wt);
    expect(checks.find((c) => c.id === "dependencies")?.status).toBe("ok");
    expect(checks.find((c) => c.id === "environment")?.status).toBe("ok");
  }, 60_000);

  test("--no-setup leaves the worktree bare; doctor says so and names worktree setup, which then does it", async () => {
    const init = await mt(
      "run",
      "init",
      "--workflow",
      "demo",
      "--task",
      "Add the second flag to the CLI",
      "--worktree",
      "--no-setup",
    );
    const d = data(init);
    expect(d.setup).toBeUndefined();
    expect((init.json.warnings as string[]).some((w) => w.startsWith("dependencies"))).toBe(true);
    const id = (d.worktree as { id: string }).id;
    const before = (data(await mt("doctor", "--worktree", id)) as { checks: Check[] }).checks;
    expect(before.find((c) => c.id === "dependencies")).toMatchObject({
      status: "warn",
      fix: "metator worktree setup --worktree <id>",
    });
    const setup = await mt("worktree", "setup", "--worktree", id);
    expect(setup.code).toBe(0);
    expect((data(setup) as { dependencies: string }).dependencies).toBe("reused");
    expect(
      (data(await mt("worktree", "setup", "--worktree", id)) as { dependencies: string }).dependencies,
    ).toBe("present");
    const after = (data(await mt("doctor", "--worktree", id)) as { checks: Check[] }).checks;
    expect(after.find((c) => c.id === "dependencies")?.status).toBe("ok");
  }, 60_000);

  test("a run in the checkout has no worktree to set up", async () => {
    const init = data(
      await mt("run", "init", "--workflow", "demo", "--task", "Add the third flag to the CLI"),
    );
    const r = await mt("worktree", "setup", "--run", init.runId as string);
    expect([r.code, (r.json.error as { message: string }).message]).toEqual([
      64,
      `run ${init.runId} works in your checkout, not in a worktree: there is nothing to set up`,
    ]);
    const doctor = await mt("doctor", "--run", init.runId as string);
    expect(doctor.code).toBe(64);
    void join;
  });
});
