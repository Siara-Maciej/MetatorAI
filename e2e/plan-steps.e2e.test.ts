/**
 * Build checkpoints end to end (Etap 3): the real `metator` process checks plan steps against a
 * real repository with a real `bun test`. A bug put into the code while a step is built stops
 * that step at once, not only the gates stage at the end; the build stage's gate passes only
 * when every step passed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const RUN = ".metator/runs/r1";
const PLAN = {
  kind: "Plan",
  schemaVersion: 1,
  task: "a discount on the invoice",
  scope: ["src/**"],
  steps: [
    { id: "S1", action: "create", path: "src/discount.test.ts", intent: "the cases" },
    {
      id: "S2",
      action: "create",
      path: "src/discount.ts",
      intent: "the discount",
      testsFirst: ["src/discount.test.ts"],
      dependsOn: ["S1"],
    },
  ],
};
const TESTS = `import { expect, test } from "bun:test";
import { discount } from "./discount.ts";
test("ten percent off a hundred", () => expect(discount(100)).toBe(90));
`;
const GOOD = "export const discount = (total: number): number => total * 0.9;\n";
const BUGGY = "export const discount = (total: number): number => total * 0.8;\n";

let repo: ScratchRepo;
const mt = (...args: string[]) => metator(args, repo.root);
type Data = Record<string, unknown>;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", "node_modules/\n.metator/\n");
  await repo.write(
    "package.json",
    JSON.stringify({ name: "shop", private: true, scripts: { test: "bun test" } }),
  );
  await repo.write("src/index.ts", "export {};\n");
  await repo.commit("init");
  await repo.write(`${RUN}/plan.json`, JSON.stringify(PLAN, null, 2));
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator plan done | progress (real CLI, real bun test)", () => {
  test("a step on top of an unchecked one is refused; a bug stops its step; the gate waits for every step", async () => {
    await repo.write("src/discount.test.ts", TESTS);
    // S2 before S1: refused, nothing runs.
    const early = await mt("plan", "done", `${RUN}/plan.json`, "S2");
    expect([early.code, (early.json.error as Data).code]).toEqual([1, "CHECK_FAILED"]);
    expect((early.json.error as Data).message).toContain("S1");

    // S1 is the tests: checked once the code they import exists.
    await repo.write("src/discount.ts", GOOD);
    expect((await mt("plan", "done", `${RUN}/plan.json`, "S1")).code).toBe(0);

    // The implementer puts a bug in: the step stops here, with the failing output.
    await repo.write("src/discount.ts", BUGGY);
    const red = await mt("plan", "done", `${RUN}/plan.json`, "S2");
    expect([red.code, (red.json.error as Data).code]).toEqual([1, "CHECK_FAILED"]);
    const details = (red.json.error as { details: { output: string; tests: string[] } }).details;
    expect(details.tests).toEqual(["src/discount.test.ts"]);
    expect(details.output).toContain("90");
    const gate = await mt("plan", "progress", `${RUN}/plan.json`, "--check");
    expect([gate.code, (gate.json.error as Data).message]).toEqual([1, "1 step(s) not passed: S2 (failed)"]);

    // Fixed: the step passes and the build stage's gate with it.
    await repo.write("src/discount.ts", GOOD);
    const green = await mt("plan", "done", `${RUN}/plan.json`, "S2");
    expect([green.code, (green.json.data as Data).progress]).toEqual([0, "2/2 steps passed"]);
    const done = await mt("plan", "progress", `${RUN}/plan.json`, "--check");
    expect([done.code, (done.json.data as Data).done]).toEqual([0, true]);
    expect((await findUnversioned(repo.root, [RUN])).unversioned).toEqual([]);
  }, 120_000);
});
