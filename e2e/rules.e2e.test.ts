/**
 * Rule canon end to end: the real `metator` process in a real git repository with a real
 * ast-grep installation (linked into node_modules/.bin, as `bun add -d @ast-grep/cli` would).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const SELF = join(import.meta.dir, "..");
const AST_GREP = join(SELF, "node_modules/.bin/ast-grep");

const RULES = `kind: RuleSet
schemaVersion: 1
area: TS
description: TypeScript conventions of the acme repo.
rules:
  - id: ACME-TS-001
    title: No var declarations
    applyTo: ["src/**"]
    enforcement: E1
    implementation: ast-grep:no-var
    summary: Use const or let; var leaks out of blocks.
    rationale: docs/adr/0001-style.md
    source: { ref: "docs/style.md#declarations", verified: 2026-10-01 }
  - id: ACME-TS-002
    title: Money is integer cents
    applyTo: ["src/billing/**"]
    enforcement: E2
    summary: Amounts are integers in cents; never use floating point for money.
    rationale: docs/adr/0001-style.md
    source: { ref: "docs/style.md#money", verified: 2026-10-01 }
    do: ["const total = 1999; // cents"]
    dont: ["const total = 19.99"]
  - id: ACME-TS-003
    title: Keep UI components small
    applyTo: ["src/ui/**"]
    enforcement: E3
    summary: Split a component when it handles more than one concern.
    rationale: docs/adr/0001-style.md
    source: { ref: "docs/style.md", verified: 2026-10-01 }
`;

let repo: ScratchRepo;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", "node_modules/\n.metator/\n");
  await repo.write("sgconfig.yml", "ruleDirs: [sg/rules]\ntestConfigs:\n  - testDir: sg/tests\n");
  await repo.write(
    "sg/rules/no-var.yml",
    "id: no-var\nlanguage: TypeScript\nseverity: error\nmessage: use const or let\nrule:\n  pattern: var $A = $B\n",
  );
  await repo.write("sg/tests/no-var-test.yml", "id: no-var\nvalid: [const a = 1]\ninvalid: [var a = 1]\n");
  await repo.write("docs/adr/0001-style.md", "# ADR-0001: Style\n");
  await repo.write("docs/style.md", "# Style\n\n## Declarations\n\n## Money\n");
  await repo.write("docs/metator/rules/ts.yml", RULES);
  await repo.write("src/billing/invoice.ts", "export const total = 1999;\n");
  await repo.write("src/ui/button.ts", "export const button = () => 'ok';\n");
  await repo.commit("init");
  await mkdir(repo.path("node_modules/.bin"), { recursive: true });
  await symlink(AST_GREP, repo.path("node_modules/.bin/ast-grep"));
  await repo.git("checkout", "-q", "-b", "feature");
});

afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const error = (r: { json: Record<string, unknown> }) => r.json.error as Data & { details: Data };

describe("metator rules lint", () => {
  test("a healthy canon passes and counts enforcement levels", async () => {
    const r = await metator(["rules", "lint"], repo.root);
    expect(r.code).toBe(0);
    expect(data(r)).toEqual({ sets: 1, rules: 3, byEnforcement: { E1: 1, E2: 1, E3: 1 }, problems: [] });
  });

  test("an E1 rule bound to a missing ast-grep rule and a dead anchor fail the lint", async () => {
    const broken = RULES.replace("ast-grep:no-var", "ast-grep:no-such-rule").replace("#money", "#cash");
    await repo.write("docs/metator/rules/ts.yml", broken);
    try {
      const r = await metator(["rules", "lint"], repo.root);
      expect(r.code).toBe(1);
      expect(error(r).code).toBe("CHECK_FAILED");
      expect((error(r).details.problems as { message: string }[]).map((p) => p.message)).toEqual([
        "ast-grep:no-such-rule does not exist (engine rules: 1)",
        "link target not found: docs/style.md#cash",
      ]);
    } finally {
      await repo.write("docs/metator/rules/ts.yml", RULES);
    }
  });

  test("an invalid document reports the exact field", async () => {
    await repo.write(
      "docs/metator/rules/bad.yml",
      "kind: RuleSet\nschemaVersion: 1\narea: TS\nrules:\n  - id: nope\n",
    );
    try {
      const r = await metator(["rules", "lint"], repo.root);
      expect(r.code).toBe(1);
      expect(JSON.stringify(error(r).details)).toContain("docs/metator/rules/bad.yml");
    } finally {
      await Bun.file(repo.path("docs/metator/rules/bad.yml")).delete();
    }
  });
});

describe("metator rules pack / show", () => {
  test("explicit paths: E2 rules in full, E1 as a one-liner, other areas left out", async () => {
    const r = await metator(["rules", "pack", "--paths", "./src/billing/invoice.ts"], repo.root);
    expect(r.code).toBe(0);
    expect(data(r).paths).toEqual(["src/billing/invoice.ts"]);
    expect((data(r).rules as { id: string }[]).map((x) => x.id)).toEqual(["ACME-TS-002"]);
    expect(data(r).enforcedByTools).toEqual([
      { id: "ACME-TS-001", title: "No var declarations", implementation: "ast-grep:no-var" },
    ]);
  });

  test("default: rules for the files changed on the branch", async () => {
    await repo.write("src/ui/button.ts", "export const button = () => 'changed';\n");
    try {
      const r = await metator(["rules", "pack", "--base", "main"], repo.root);
      expect(data(r).paths).toEqual(["src/ui/button.ts"]);
      expect((data(r).rules as { id: string }[]).map((x) => x.id)).toEqual(["ACME-TS-003"]);
    } finally {
      await repo.git("checkout", "--", "src/ui/button.ts");
    }
  });

  test("an invalid budget is a usage error", async () => {
    expect((await metator(["rules", "pack", "--paths", "src/a.ts", "--budget", "-5"], repo.root)).code).toBe(
      64,
    );
  });

  test("show prints one rule with its canon file; unknown ids are NOT_FOUND", async () => {
    const r = await metator(["rules", "show", "ACME-TS-002"], repo.root);
    expect(data(r)).toMatchObject({
      id: "ACME-TS-002",
      area: "TS",
      source: { file: "docs/metator/rules/ts.yml" },
    });
    const missing = await metator(["rules", "show", "ACME-TS-404"], repo.root);
    expect([missing.code, error(missing).code]).toEqual([1, "NOT_FOUND"]);
  });
});

describe("metator rules adapters", () => {
  const FILE = ".github/instructions/acme-ts.instructions.md";

  test("generates a versioned Copilot instructions file; --check passes right after", async () => {
    const r = await metator(["rules", "adapters"], repo.root);
    expect(data(r).written).toEqual([FILE]);
    const text = await repo.read(FILE);
    expect(text).toContain("applyTo: src/**,src/billing/**,src/ui/**\n");
    expect(text).toContain("## ACME-TS-002: Money is integer cents");
    expect(text).toContain("- ACME-TS-001: No var declarations (`ast-grep:no-var`)");
    expect((await findUnversioned(repo.root, [".github/instructions"])).unversioned).toEqual([]);
    expect((await metator(["rules", "adapters", "--check"], repo.root)).code).toBe(0);
  });

  test("a hand edit makes --check fail without touching the file; regenerating fixes it", async () => {
    await metator(["rules", "adapters"], repo.root);
    await repo.write(FILE, `${await repo.read(FILE)}\nmanual note\n`);
    const r = await metator(["rules", "adapters", "--check"], repo.root);
    expect([r.code, error(r).code]).toEqual([1, "CHECK_FAILED"]);
    expect(error(r).details.stale).toEqual([FILE]);
    expect(await repo.read(FILE)).toContain("manual note");
    await metator(["rules", "adapters"], repo.root);
    expect((await metator(["rules", "adapters", "--check"], repo.root)).code).toBe(0);
  });

  test("a canon change makes generated instructions stale", async () => {
    await metator(["rules", "adapters"], repo.root);
    await repo.write(
      "docs/metator/rules/ts.yml",
      RULES.replace("Money is integer cents", "Money is integer minor units"),
    );
    try {
      expect((await metator(["rules", "adapters", "--check"], repo.root)).code).toBe(1);
    } finally {
      await repo.write("docs/metator/rules/ts.yml", RULES);
    }
  });
});

describe("metator rules check (real ast-grep)", () => {
  test("a violation is reported with the canon rule id and fails the command", async () => {
    await repo.write("src/billing/legacy.ts", "var rate = 0.23;\nexport { rate };\n");
    try {
      const r = await metator(["rules", "check"], repo.root);
      expect(r.code).toBe(1);
      expect(error(r).details.violations).toEqual([
        {
          source: "ast-grep",
          toolRuleId: "no-var",
          canonRuleId: "ACME-TS-001",
          engine: "ast-grep",
          file: "src/billing/legacy.ts",
          line: 1,
          column: 1,
          severity: "error",
          message: "use const or let",
        },
      ]);
      const clean = await metator(["rules", "check", "--files", "src/billing/invoice.ts"], repo.root);
      expect([clean.code, data(clean).violations]).toEqual([0, []]);
    } finally {
      await Bun.file(repo.path("src/billing/legacy.ts")).delete();
    }
  });

  test("--base checks only the branch's changes", async () => {
    await repo.git("checkout", "-q", "main");
    await repo.write("src/old.ts", "var legacy = 1;\nexport { legacy };\n");
    await repo.git("add", "src/old.ts");
    await repo.git("commit", "-q", "-m", "legacy code on main");
    await repo.git("checkout", "-q", "feature");
    await repo.git("merge", "-q", "main");
    try {
      // The violation is on main already: a branch-only check does not see it, a full check does.
      const branch = await metator(["rules", "check", "--base", "main"], repo.root);
      expect([branch.code, data(branch).violations]).toEqual([0, []]);
      expect((await metator(["rules", "check"], repo.root)).code).toBe(1);
      await repo.write("src/ui/button.ts", "var x = 1;\nexport const button = () => x;\n");
      const changed = await metator(["rules", "check", "--base", "main"], repo.root);
      expect(changed.code).toBe(1);
      expect((error(changed).details.violations as { file: string }[]).map((v) => v.file)).toEqual([
        "src/ui/button.ts",
      ]);
    } finally {
      await repo.git("checkout", "--", "src/ui/button.ts");
    }
  });

  test("schema prints the RuleSet JSON Schema", async () => {
    const r = await metator(["rules", "schema"], repo.root);
    expect((data(r).properties as Data).kind).toEqual({ const: "RuleSet" });
  });
});

describe("metator rules coverage / scaffold", () => {
  test("coverage reports the E1 share and --min-e1 gates it", async () => {
    const r = await metator(["rules", "coverage"], repo.root);
    expect((data(r).total as Data).e1Percent).toBe(33);
    const gate = await metator(["rules", "coverage", "--min-e1", "50"], repo.root);
    expect([gate.code, error(gate).code]).toEqual([1, "CHECK_FAILED"]);
  });

  test("scaffold writes a rule and a failing test next to the existing ones; never twice", async () => {
    const r = await metator(["rules", "scaffold", "ACME-TS-002"], repo.root);
    expect(r.code).toBe(0);
    expect(data(r).files).toEqual(["sg/rules/acme-ts-002.yml", "sg/tests/acme-ts-002-test.yml"]);
    expect(await repo.read("sg/rules/acme-ts-002.yml")).toContain(
      'message: "ACME-TS-002: Money is integer cents"',
    );
    try {
      expect((await metator(["rules", "scaffold", "ACME-TS-002"], repo.root)).code).toBe(64);
      expect((await metator(["rules", "scaffold", "ACME-TS-001"], repo.root)).code).toBe(64); // already E1
      expect(
        (await metator(["rules", "scaffold", "ACME-TS-002", "--engine", "eslint"], repo.root)).code,
      ).toBe(64);
    } finally {
      await Bun.file(repo.path("sg/rules/acme-ts-002.yml")).delete();
      await Bun.file(repo.path("sg/tests/acme-ts-002-test.yml")).delete();
    }
  });
});

describe("dogfood: the MetatorAI rule canon", () => {
  test("at least 40% of the rules are enforced by tools", async () => {
    expect((await metator(["rules", "coverage", "--min-e1", "40", "--root", SELF], SELF)).code).toBe(0);
  });

  test("lints clean and its generated instructions are up to date", async () => {
    const lint = await metator(["rules", "lint", "--root", SELF], SELF);
    expect([lint.code, data(lint).problems]).toEqual([0, []]);
    expect((data(lint).byEnforcement as Data).E1).toBeGreaterThanOrEqual(5);
    expect((await metator(["rules", "adapters", "--check", "--root", SELF], SELF)).code).toBe(0);
  });

  test("the architecture rules are enforced: no violations in this repository", async () => {
    const r = await metator(["rules", "check", "--root", SELF], SELF);
    expect([r.code, data(r).violations]).toEqual([0, []]);
  });
});
