/** Conformance tests as an E1 engine end to end: real `metator`, real git repo, real `bun test`. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const RULES = `kind: RuleSet
schemaVersion: 1
area: DOC
rules:
  - id: ACME-DOC-001
    title: Every module has a README
    applyTo: ["modules/**"]
    enforcement: E1
    implementation: test:acme-doc-001
    summary: Each directory under modules/ has a README.md.
    rationale: README.md
    source: { ref: README.md, verified: 2026-10-26 }
`;

const CONFORMANCE = (withRejectsCase: boolean) => `import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const root = join(import.meta.dir, "../..");
const missing = (dir: string) =>
  readdirSync(join(root, dir)).filter((m) => !existsSync(join(root, dir, m, "README.md")));

test("every module has a README", () => expect(missing("modules")).toEqual([]));
${withRejectsCase ? 'test("rejects a module without one", () => expect(missing("fixtures")).toEqual(["bare"]));' : ""}
`;

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("README.md", "# acme\n");
  await repo.write("docs/metator/rules/doc.yml", RULES);
  await repo.write("rules/conformance/acme-doc-001.test.ts", CONFORMANCE(true));
  await repo.write("modules/billing/README.md", "# billing\n");
  await repo.write("fixtures/bare/index.ts", "export {};\n");
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;
const data = (r: { json: Data }) => r.json.data as Data;

describe("conformance tests as an E1 engine (real CLI)", () => {
  test("a rule bound to a passing conformance test with a rejects case is tested E1", async () => {
    expect((await metator(["rules", "lint"], repo.root)).code).toBe(0);
    const coverage = data(await metator(["rules", "coverage", "--min-e1", "100"], repo.root));
    expect([(coverage.total as Data).e1Percent, coverage.e1WithoutTest, coverage.e1Unverified]).toEqual([
      100,
      [],
      [],
    ]);
    const check = data(await metator(["rules", "check"], repo.root));
    expect([check.engines, check.violations]).toEqual([["test"], []]);
  });

  test("a failing conformance test is a violation of its canon rule, whatever files changed", async () => {
    await repo.write("modules/ledger/index.ts", "export {};\n");
    try {
      const r = await metator(["rules", "check", "--files", "README.md"], repo.root);
      expect(r.code).toBe(1);
      const v = ((r.json.error as { details: Data }).details.violations as Data[])[0];
      expect([v?.engine, v?.canonRuleId, v?.file]).toEqual([
        "test",
        "ACME-DOC-001",
        "rules/conformance/acme-doc-001.test.ts",
      ]);
      expect(v?.message).toContain("ledger");
    } finally {
      await repo.git("clean", "-fdq", "modules");
    }
  });

  test("a conformance test that never proves it rejects bad input is E1 without a test", async () => {
    await repo.write("rules/conformance/acme-doc-001.test.ts", CONFORMANCE(false));
    try {
      expect(data(await metator(["rules", "coverage"], repo.root)).e1WithoutTest).toEqual(["ACME-DOC-001"]);
    } finally {
      await repo.git("checkout", "--", "rules/conformance/acme-doc-001.test.ts");
    }
  });
});
