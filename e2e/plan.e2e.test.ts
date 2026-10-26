/**
 * Plan gate end to end: the real `metator` process lints and scopes plans against a real git
 * repository with a pattern catalog (real ast-grep) and a real import graph.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const SELF = join(import.meta.dir, "..");
const PATTERN = `kind: Pattern
schemaVersion: 1
id: mapper
title: Mapper
intent: Map a persistence record to a domain object with a pure function.
when: a new entity crosses the persistence boundary
detection: ast-grep:mt-pattern-mapper
exemplar: src/orders/order.mapper.ts
minOccurrences: 1
`;
const RULE = `id: mt-pattern-mapper
language: TypeScript
severity: hint
message: mapper
rule:
  pattern: 'export function $NAME(record: $R) { $$$ }'
`;
const RUN = ".metator/runs/r1";

type Data = Record<string, unknown>;
const step = (id: string, action: string, path: string, extra: Data = {}) => ({
  id,
  action,
  path,
  intent: `step ${id}`,
  ...extra,
});
const plan = (steps: Data[]) =>
  JSON.stringify(
    { kind: "Plan", schemaVersion: 1, task: "invoice mapper", scope: ["src/billing/**"], steps },
    null,
    2,
  );
const HEALTHY = [
  step("S1", "create", "src/billing/invoice.mapper.test.ts"),
  step("S2", "create", "src/billing/invoice.mapper.ts", {
    patternSource: { pattern: "mapper", exemplar: "src/orders/order.mapper.ts:1", reason: "same boundary" },
    testsFirst: ["src/billing/invoice.mapper.test.ts"],
    dependsOn: ["S1"],
  }),
  step("S3", "modify", "src/billing/money.test.ts"),
  step("S4", "modify", "src/billing/money.ts", {
    testsFirst: ["src/billing/money.test.ts"],
    dependsOn: ["S3"],
  }),
  step("S5", "modify", "src/billing/invoice.ts", {
    testsFirst: ["src/billing/invoice.mapper.test.ts"],
    dependsOn: ["S2", "S4"],
  }),
];

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", "node_modules/\n.metator/\n");
  await repo.write("package.json", JSON.stringify({ name: "shop", private: true }));
  await repo.write(
    "sgconfig.yml",
    "ruleDirs: [docs/metator/patterns/sg]\ntestConfigs:\n  - testDir: docs/metator/patterns/sg-tests\n",
  );
  await repo.write("docs/metator/patterns/sg/mt-pattern-mapper.yml", RULE);
  await repo.write(
    "docs/metator/patterns/sg-tests/mt-pattern-mapper-test.yml",
    'id: mt-pattern-mapper\nvalid: ["export const x = 1;"]\ninvalid: ["export function toOrder(record: Row) { return record; }"]\n',
  );
  await repo.write("docs/metator/patterns/mapper.yml", PATTERN);
  await repo.write(
    "src/orders/order.mapper.ts",
    "export function toOrder(record: Row) { return { id: record.id }; }\n",
  );
  await repo.write("src/billing/money.ts", "export const cents = (n: number) => n * 100;\n");
  await repo.write(
    "src/billing/money.test.ts",
    'import { cents } from "./money.ts";\nexport const t = cents(1);\n',
  );
  await repo.write(
    "src/billing/invoice.ts",
    'import { cents } from "./money.ts";\nexport const fee = cents(2);\n',
  );
  await repo.commit("init");
  await mkdir(repo.path("node_modules/.bin"), { recursive: true });
  await symlink(join(SELF, "node_modules/.bin/ast-grep"), repo.path("node_modules/.bin/ast-grep"));
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator plan lint (real CLI)", () => {
  test("a plan with exemplars, tests first and graph order passes", async () => {
    await repo.write(`${RUN}/plan.json`, plan(HEALTHY));
    const r = await metator(["plan", "lint", `${RUN}/plan.json`], repo.root);
    expect([r.code, r.json.data]).toEqual([0, { steps: 5, problems: [], adrRequired: [] }]);
  });

  test("every broken rule of the plan gate is reported at once (exit 1)", async () => {
    const broken = [
      step("S1", "create", "src/billing/invoice.mapper.ts", {
        patternSource: { pattern: "mapper", exemplar: "src/billing/money.ts:1", reason: "r" },
      }),
      step("S2", "modify", "src/billing/invoice.ts", { testsFirst: ["src/billing/money.test.ts"] }),
      step("S3", "modify", "src/billing/money.ts", {
        testsFirst: ["src/billing/money.test.ts"],
        dependsOn: ["S2"],
      }),
      step("S4", "create", "src/orders/order.ts", { newPatternAdr: "docs/adr/0099-orders.md" }),
    ];
    await repo.write(`${RUN}/plan.json`, plan(broken));
    const r = await metator(["plan", "lint", `${RUN}/plan.json`], repo.root);
    expect(r.code).toBe(1);
    const details = (r.json.error as { details: Data }).details;
    const problems = (details.problems as { step: string; message: string }[]).map(
      (p) => `${p.step}: ${p.message}`,
    );
    expect(problems).toEqual([
      "S1: src/billing/money.ts is not an occurrence of pattern mapper",
      "S1: code changes need testsFirst (the tests written before it)",
      "S2: src/billing/money.test.ts must be written by a step this one depends on",
      "S3: src/billing/money.test.ts must be written by a step this one depends on",
      "S4: src/orders/order.ts is outside the task scope",
      "S4: code changes need testsFirst (the tests written before it)",
      "S2: src/billing/invoice.ts imports src/billing/money.ts: depend on S3",
      "S4: introduces a new abstraction: the ADR must be accepted first",
    ]);
    expect(details.adrRequired).toEqual(["S4"]);
  });

  test("a missing plan is NOT_FOUND; an unversioned one is invalid", async () => {
    expect((await metator(["plan", "lint", `${RUN}/none.json`], repo.root)).json.error).toMatchObject({
      code: "NOT_FOUND",
    });
    await repo.write(`${RUN}/raw.json`, JSON.stringify({ task: "t", scope: ["**"], steps: [] }));
    expect((await metator(["plan", "lint", `${RUN}/raw.json`], repo.root)).json.error).toMatchObject({
      code: "INVALID_ARTIFACT",
    });
    await rm(repo.path(`${RUN}/raw.json`));
  });
});

describe("metator plan scope / schema (real CLI)", () => {
  test("writes a versioned plan-scope.json with the edit files and independent shards", async () => {
    await repo.write(`${RUN}/plan.json`, plan([...HEALTHY, step("S6", "create", "src/billing/README.md")]));
    const r = await metator(["plan", "scope", `${RUN}/plan.json`], repo.root);
    expect(r.code).toBe(0);
    const scope = r.json.data as { output: string; edit: string[]; shards: { steps: string[] }[] };
    expect(scope.output).toBe(`${RUN}/plan-scope.json`);
    expect(scope.edit).toContain("src/billing/invoice.mapper.test.ts");
    expect(scope.shards.map((s) => s.steps)).toEqual([["S1", "S2", "S3", "S4", "S5"], ["S6"]]);
    const saved = JSON.parse(await repo.read(`${RUN}/plan-scope.json`)) as Data;
    expect([saved.kind, saved.schemaVersion]).toEqual(["PlanScope", 1]);
    expect((await findUnversioned(repo.root, [RUN])).unversioned).toEqual([]);

    const custom = await metator(
      ["plan", "scope", `${RUN}/plan.json`, "--out", `${RUN}/scope/s.json`],
      repo.root,
    );
    expect((custom.json.data as Data).output).toBe(`${RUN}/scope/s.json`);
  });

  test("plan schema prints the Plan JSON Schema", async () => {
    const schema = (await metator(["plan", "schema"], repo.root)).json.data as {
      properties: Record<string, Data>;
    };
    expect(schema.properties.kind?.const).toBe("Plan");
    expect(Object.keys(schema.properties)).toEqual(["kind", "schemaVersion", "task", "scope", "steps"]);
  });
});
