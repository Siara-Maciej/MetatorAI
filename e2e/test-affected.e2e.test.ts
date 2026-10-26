/**
 * `test affected` end to end: the real `metator` process on a real Bun-workspaces monorepo
 * (real git, real import graph) runs the affected tests with the repository's own `bun test`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMonorepo } from "@metator/testing";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const MONEY = "packages/money/src";
const TAX = "packages/billing/src/tax.test.ts";
let repo: ScratchRepo;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await createMonorepo(repo.root);
  const manifest = JSON.parse(await repo.read("package.json")) as Record<string, unknown>;
  await repo.write("package.json", JSON.stringify({ ...manifest, scripts: { test: "bun test" } }, null, 2));
  await repo.write(
    `${MONEY}/money.test.ts`,
    'import { expect, test } from "bun:test";\nimport { add } from "./money.ts";\ntest("adds", () => expect(add(1, 2)).toBe(3));\n',
  );
  await repo.write(
    TAX,
    'import { expect, test } from "bun:test";\nimport { tax } from "./tax.js";\ntest("tax is a number", () => expect(typeof tax(1)).toBe("number"));\n',
  );
  // The fixture's app test runs code that needs an uninstalled package; keep it out of the graph.
  await repo.write(
    "apps/web/src/main.test.ts",
    'import { expect, test } from "bun:test";\ntest("app", () => expect(1).toBe(1));\n',
  );
  await repo.commit("init");
}, 60_000);
afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;

describe("metator test affected (real CLI, real bun test)", () => {
  test("nothing changed: no test runs", async () => {
    const r = await metator(["test", "affected"], repo.root);
    expect([r.code, (r.json.data as Data).tests, (r.json.data as Data).command]).toEqual([0, [], null]);
  });

  test("a change runs only the tests that reach it, through the repo's test script", async () => {
    await repo.write(`${MONEY}/currency.ts`, 'export type Currency = "PLN" | "EUR" | "USD";\n');
    const r = await metator(["test", "affected"], repo.root);
    expect(r.code).toBe(0);
    const data = r.json.data as { tests: string[]; command: string[]; passed: boolean };
    expect(data.tests).toContain(`${MONEY}/money.test.ts`);
    expect(data.tests).not.toContain(TAX);
    expect(data.command.slice(-data.tests.length)).toEqual(data.tests);
    expect(data.passed).toBe(true);
    await repo.git("checkout", "--", `${MONEY}/currency.ts`);
  });

  test("a change that breaks an affected test fails with the runner's output (exit 1)", async () => {
    await repo.write(`${MONEY}/money.ts`, "export const add = (a: number, b: number) => a - b;\n");
    try {
      const r = await metator(["test", "affected"], repo.root);
      expect(r.code).toBe(1);
      const details = (r.json.error as { details: Data }).details;
      expect([details.passed, details.exitCode]).toEqual([false, 1]);
      expect(String(details.output)).toContain("adds");
    } finally {
      await repo.git("checkout", "--", `${MONEY}/money.ts`);
    }
  });

  test("explicit files and an unknown script", async () => {
    const r = await metator(["test", "affected", "--files", "packages/billing/src/tax.ts"], repo.root);
    expect((r.json.data as Data).tests).toContain(TAX);
    expect((r.json.data as Data).tests).not.toContain(`${MONEY}/money.test.ts`);
    const missing = await metator(
      ["test", "affected", "--files", "packages/billing/src/tax.ts", "--script", "nope"],
      repo.root,
    );
    expect(missing.code).toBe(1);
  });
});
