/** `flaky check` end to end: the real `metator` process runs a real bun test several times. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(
    "package.json",
    JSON.stringify({ name: "shop", private: true, scripts: { test: "bun test" } }),
  );
  await repo.write(
    "src/stable.test.ts",
    'import { expect, test } from "bun:test";\ntest("stable", () => expect(1).toBe(1));\n',
  );
  // Fails on every second run: a counter file next to the test.
  await repo.write(
    "src/flaky.test.ts",
    'import { expect, test } from "bun:test";\nimport { existsSync, readFileSync, writeFileSync } from "node:fs";\nconst f = import.meta.dir + "/.count";\nconst n = existsSync(f) ? Number(readFileSync(f, "utf8")) + 1 : 1;\nwriteFileSync(f, String(n));\ntest("alternates", () => expect(n % 2).toBe(1));\n',
  );
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator flaky check (real CLI, real bun test)", () => {
  test("a deterministic test passes every run", async () => {
    const r = await metator(["flaky", "check", "src/stable.test.ts", "--runs", "3"], repo.root);
    expect([r.code, r.json.data]).toEqual([
      0,
      { test: "src/stable.test.ts", runs: 3, passed: 3, failed: 0, flaky: false },
    ]);
  }, 60_000);

  test("a test that alternates is reported flaky with its failure (exit 1)", async () => {
    const r = await metator(["flaky", "check", "src/flaky.test.ts", "--runs", "4"], repo.root);
    expect(r.code).toBe(1);
    const details = (r.json.error as { message: string; details: Record<string, unknown> }).details;
    expect([details.passed, details.failed, details.flaky]).toEqual([2, 2, true]);
    expect(String(details.firstFailure)).toContain("alternates");
  }, 60_000);
});
