/**
 * `coverage diff` and the MetatorAI gate steps end to end: real git history, a real LCOV report
 * from `bun test --coverage`, and `gate all` running `test affected`, `graph diff` and
 * `coverage diff` from a v2 metator.config.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const MONEY = "export const add = (a: number, b: number) => a + b;\n";
const MONEY_TEST =
  'import { expect, test } from "bun:test";\nimport { add } from "./money.ts";\ntest("adds", () => expect(add(1, 2)).toBe(3));\n';
const CONFIG = `kind: MetatorConfig
schemaVersion: 2
gates:
  full:
    - id: tests
      run: { metator: test affected }
    - id: graph
      run: { metator: graph diff }
    - id: coverage
      run: { metator: coverage diff --min 90 }
`;

let repo: ScratchRepo;
const coverage = async () => {
  const proc = Bun.spawn(["bun", "test", "--coverage", "--coverage-reporter=lcov"], {
    cwd: repo.root,
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
};

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", "node_modules/\n.metator/\ncoverage/\n");
  await repo.write(
    "package.json",
    JSON.stringify({ name: "shop", private: true, scripts: { test: "bun test" } }),
  );
  await repo.write("metator.config.yml", CONFIG);
  await repo.write("src/money.ts", MONEY);
  await repo.write("src/money.test.ts", MONEY_TEST);
  await repo.commit("init");
  await repo.git("checkout", "-q", "-b", "feature");
});
afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;

describe("metator coverage diff (real git, real bun coverage)", () => {
  test("added lines a test runs are covered; added lines nothing runs are not", async () => {
    await repo.write(
      "src/money.ts",
      `${MONEY}export const sub = (a: number, b: number) => {\n  return a - b;\n};\nexport const mul = (a: number, b: number) => a * b;\n`,
    );
    await repo.write("src/money.test.ts", `${MONEY_TEST}test("subs", () => expect(1).toBe(1));\n`);
    expect(await coverage()).toBe(0);
    const r = await metator(["coverage", "diff", "--base", "main"], repo.root);
    expect(r.code).toBe(0);
    const d = r.json.data as {
      instrumented: number;
      covered: number;
      files: { file: string; uncovered: number[] }[];
    };
    // sub's body never runs; the declarations around it do (bun counts them).
    expect([d.instrumented, d.covered]).toEqual([3, 2]);
    expect(d.files).toEqual([{ file: "src/money.ts", uncovered: [3] }].map((f) => ({ ...f, covered: 2 })));
    const strict = await metator(["coverage", "diff", "--base", "main", "--min", "100"], repo.root);
    expect([strict.code, (strict.json.error as Data).code]).toEqual([1, "CHECK_FAILED"]);
  });

  test("a new file no test loads is unmeasured; a missing report says how to make one", async () => {
    await repo.write("src/tax.ts", "export const tax = 1;\n");
    const r = await metator(["coverage", "diff", "--base", "main"], repo.root);
    expect((r.json.data as { unmeasured: string[] }).unmeasured).toEqual(["src/tax.ts"]);
    expect(r.json.warnings).toEqual(["src/tax.ts: added code that no test loaded"]);
    const missing = await metator(["coverage", "diff", "--lcov", "nope.info"], repo.root);
    expect((missing.json.error as { hint: string }).hint).toContain("--coverage-reporter=lcov");
    await repo.git("clean", "-fq", "src/tax.ts");
  });
});

describe("metator gate all with MetatorAI steps (v2 config)", () => {
  test("test affected and graph diff pass; coverage under the minimum fails the gate with the lines", async () => {
    const r = await metator(["gate", "all", "--base", "main"], repo.root);
    expect(r.code).toBe(1);
    const steps = (r.json.error as { details: { steps: { id: string; status: string; detail?: string }[] } })
      .details.steps;
    expect(steps.map((s) => `${s.id}:${s.status}`)).toEqual(["tests:pass", "graph:pass", "coverage:fail"]);
    expect(steps[2]?.detail).toContain("src/money.ts: uncovered");
  }, 60_000);

  test("covering the new code makes the gate green", async () => {
    await repo.write(
      "src/money.test.ts",
      `${MONEY_TEST}import { mul, sub } from "./money.ts";\ntest("subs and muls", () => {\n  expect(sub(3, 1)).toBe(2);\n  expect(mul(2, 3)).toBe(6);\n});\n`,
    );
    expect(await coverage()).toBe(0);
    const r = await metator(["gate", "all", "--base", "main"], repo.root);
    expect([r.code, (r.json.data as { passed: boolean }).passed]).toEqual([0, true]);
  }, 60_000);

  test("an unknown MetatorAI step is a config error naming the allowed ones", async () => {
    await repo.write("metator.config.yml", CONFIG.replace("graph diff", "graph explode"));
    try {
      const r = await metator(["gate", "all"], repo.root);
      expect([r.code, (r.json.error as Data).code]).toEqual([1, "INVALID_CONFIG"]);
      expect(JSON.stringify(r.json.error)).toContain(
        "expected one of: rules check, test affected, graph diff",
      );
    } finally {
      await repo.write("metator.config.yml", CONFIG);
    }
  });
});
