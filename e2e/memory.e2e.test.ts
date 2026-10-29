/** Memory map end to end: the real `metator` process on real files in a real git repository. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const SELF = join(import.meta.dir, "..");

const MAP = `kind: MemoryMap
schemaVersion: 1
tierBudgets:
  T0: { chars: 400 }
items:
  - id: t0.agents
    tier: T0
    kind: canon
    paths: ["AGENTS.md"]
    load: always
    writers: [human]
    readers: ["*"]
    budget: { lines: 20 }
  - id: t1.docs
    tier: T1
    kind: canon
    paths: ["docs/**/*.md"]
    load: explicit
    writers: [human]
    readers: ["*"]
  - id: t1.map
    tier: T1
    kind: canon
    paths: ["docs/metator/memory-map.yml"]
    load: explicit
    writers: [human]
    readers: ["*"]
`;

const PAY =
  'export function pay(amount: number): number {\n  if (amount < 0) throw new Error("negative");\n  return amount;\n}\n';
const CARD =
  '# billing\n\nNegative amounts are rejected [[cite: src/pay.ts:2 | "if (amount < 0) throw"]].\n\n```md\n[[cite: src/example.ts:1 | "only an example"]]\n```\n';

let repo: ScratchRepo;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("AGENTS.md", "# Agents\n\nRun `bun test`.\n");
  await repo.write("docs/modules/billing.md", CARD);
  await repo.write("src/pay.ts", PAY);
  await repo.commit("init");
});

afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const details = (r: { json: Record<string, unknown> }) => (r.json.error as { details: Data }).details;

describe("metator memory inventory", () => {
  test("without a map: every knowledge file, sizes, all unmapped", async () => {
    const r = await metator(["memory", "inventory"], repo.root);
    expect(r.code).toBe(0);
    expect(data(r).mapped).toBe(false);
    expect(data(r).unmapped).toEqual(["AGENTS.md", "docs/modules/billing.md"]);
  });

  test("other commands need a map and say how to start one", async () => {
    const r = await metator(["memory", "check"], repo.root);
    expect([r.code, (r.json.error as Data).code]).toEqual([1, "NOT_FOUND"]);
    expect((r.json.error as Data).hint).toContain("memory inventory");
  });
});

describe("with a memory map", () => {
  beforeAll(async () => {
    await repo.write("docs/metator/memory-map.yml", MAP);
  });

  test("check passes; the code-block example citation is not a claim", async () => {
    const r = await metator(["memory", "check"], repo.root);
    expect([r.code, data(r).problems]).toEqual([0, []]);
    const v = await metator(["memory", "validate"], repo.root);
    expect((data(v).citations as Data[]).map((c) => c.cites)).toEqual(["src/pay.ts:2"]);
    expect((await findUnversioned(repo.root, ["docs/metator"])).unversioned).toEqual([]);
  });

  test("a new knowledge file nobody mapped fails the guard", async () => {
    await repo.write(".github/copilot-instructions.md", "# Instructions\n");
    try {
      const r = await metator(["memory", "check"], repo.root);
      expect(r.code).toBe(1);
      expect(details(r).problems).toEqual([
        {
          severity: "error",
          path: ".github/copilot-instructions.md",
          message: "knowledge file is not covered by any memory map item",
        },
      ]);
    } finally {
      await Bun.file(repo.path(".github/copilot-instructions.md")).delete();
    }
  });

  test("code moves: validate reports it, --fix rewrites the line, then it is clean", async () => {
    await repo.write("src/pay.ts", `// Payment rules.\n// See docs/modules/billing.md.\n${PAY}`);
    const moved = await metator(["memory", "validate"], repo.root);
    expect(moved.code).toBe(1);
    expect((details(moved).counts as Data).moved).toBe(1);
    const fixed = await metator(["memory", "validate", "--fix"], repo.root);
    expect([fixed.code, (data(fixed).counts as Data).fixed]).toEqual([0, 1]);
    expect(await repo.read("docs/modules/billing.md")).toContain(
      '[[cite: src/pay.ts:4 | "if (amount < 0) throw"]]',
    );
    expect((await metator(["memory", "validate"], repo.root)).code).toBe(0);
  });

  test("the cited code is removed: the claim is stale and the guard fails", async () => {
    const before = await repo.read("src/pay.ts");
    await repo.write("src/pay.ts", "export const pay = (amount: number) => Math.max(0, amount);\n");
    try {
      const r = await metator(["memory", "check"], repo.root);
      expect(r.code).toBe(1);
      expect((details(r).problems as Data[])[0]?.message).toContain("is stale (quote not found)");
      const fix = await metator(["memory", "validate", "--fix"], repo.root);
      expect([fix.code, (details(fix).counts as Data).stale]).toEqual([1, 1]); // never auto-"fixed"
    } finally {
      await repo.write("src/pay.ts", before);
    }
  });

  test("budgets: a long always-loaded file fails budget and check", async () => {
    const before = await repo.read("AGENTS.md");
    await repo.write("AGENTS.md", `${before}${"- one more instruction\n".repeat(25)}`);
    try {
      const r = await metator(["memory", "budget"], repo.root);
      expect(r.code).toBe(1);
      const items = details(r).items as { id: string; over: { over: string[] }[] }[];
      expect(items.find((i) => i.id === "t0.agents")?.over[0]?.over).toEqual(["lines 28 > 20"]);
      expect(
        (details(r).tiers as { tier: string; over: string[] }[]).find((t) => t.tier === "T0")?.over[0],
      ).toMatch(/^chars \d+ > 400$/);
      expect((await metator(["memory", "check"], repo.root)).code).toBe(1);
    } finally {
      await repo.write("AGENTS.md", before);
    }
  });

  test("dupes: the same statement in two docs is found, --check fails, a link instead of a copy passes", async () => {
    const statement = "Negative amounts are rejected before an invoice is created or corrected.";
    await repo.write("docs/modules/orders.md", `# orders\n\n${statement}\n`);
    await repo.write("docs/modules/billing.md", `${CARD}\n${statement}\n`);
    try {
      const r = await metator(["memory", "dupes"], repo.root);
      const groups = data(r).groups as { occurrences: { file: string }[] }[];
      expect(groups.map((g) => g.occurrences.map((o) => o.file))).toEqual([
        ["docs/modules/billing.md", "docs/modules/orders.md"],
      ]);
      expect((await metator(["memory", "dupes", "--check"], repo.root)).code).toBe(1);
      await repo.write("docs/modules/orders.md", "# orders\n\nSee [billing](billing.md) for amount rules.\n");
      expect((await metator(["memory", "dupes", "--check"], repo.root)).code).toBe(0);
      expect((await metator(["memory", "dupes", "--threshold", "2"], repo.root)).code).toBe(64);
    } finally {
      await repo.write("docs/modules/billing.md", CARD);
      await Bun.file(repo.path("docs/modules/orders.md")).delete();
    }
  }, 60_000);

  test("matrix: who reads and writes which memory", async () => {
    const r = await metator(["memory", "matrix"], repo.root);
    expect((data(r).access as Data).human).toEqual({ "t0.agents": "RW", "t1.docs": "RW", "t1.map": "RW" });
    expect(data(r).markdown).toStartWith("| Agent | t0.agents | t1.docs | t1.map |");
  });

  test("schema prints the MemoryMap JSON Schema", async () => {
    const r = await metator(["memory", "schema"], repo.root);
    expect((data(r).properties as Data).kind).toEqual({ const: "MemoryMap" });
  });
});

describe("dogfood: the MetatorAI memory map", () => {
  test("no statement is duplicated across MetatorAI's knowledge files", async () => {
    expect((await metator(["memory", "dupes", "--check", "--root", SELF], SELF)).code).toBe(0);
  });

  test("every knowledge file is mapped, budgets hold and citations are true", async () => {
    const r = await metator(["memory", "check", "--root", SELF], SELF);
    expect(r.code).toBe(0);
    expect((data(r).problems as Data[]).filter((p) => p.severity === "error")).toEqual([]);
    const v = await metator(["memory", "validate", "--root", SELF], SELF);
    const counts = (v.code === 0 ? data(v) : (v.json.error as { details: Data }).details).counts as Data;
    expect([counts.stale, counts["missing-file"]]).toEqual([0, 0]);
    expect(counts.ok).toBeGreaterThanOrEqual(1);
  });
});
