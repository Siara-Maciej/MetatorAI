/**
 * Pattern catalog end to end: the real `metator` process, a real git repository and real
 * ast-grep detection rules (severity hint) with their tests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const SELF = join(import.meta.dir, "..");

const PATTERN = `kind: Pattern
schemaVersion: 1
id: query-hook
title: Query hook
intent: Fetch server data in the UI through a query hook with caching.
when: data from the API
detection: ast-grep:mt-pattern-query-hook
exemplar: src/orders/orders.queries.ts
legacy:
  - path: src/legacy/useFetch.ts
    reason: manual fetch in useEffect, no cache
`;

const RULE = `id: mt-pattern-query-hook
language: TypeScript
severity: hint
message: query hook
rule:
  pattern: export function $NAME() { return useQuery($$$ARGS); }
`;

let repo: ScratchRepo;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", "node_modules/\n.metator/\n");
  await repo.write("package.json", JSON.stringify({ name: "shop", private: true }));
  await repo.write(
    "sgconfig.yml",
    "ruleDirs: [docs/metator/patterns/sg]\ntestConfigs:\n  - testDir: docs/metator/patterns/sg-tests\n",
  );
  await repo.write("docs/metator/patterns/sg/mt-pattern-query-hook.yml", RULE);
  await repo.write(
    "docs/metator/patterns/sg-tests/mt-pattern-query-hook-test.yml",
    'id: mt-pattern-query-hook\nvalid: ["export function f() { return 1; }"]\ninvalid: ["export function useX() { return useQuery(k); }"]\n',
  );
  await repo.write("docs/metator/patterns/query-hook.yml", PATTERN);
  await repo.write(
    "src/orders/orders.queries.ts",
    'export function useOrders() { return useQuery(["orders"]); }\n',
  );
  await repo.write(
    "src/billing/invoices.queries.ts",
    'export function useInvoices() { return useQuery(["invoices"]); }\n',
  );
  await repo.write("src/legacy/useFetch.ts", 'export function useFetch() { return useQuery(["any"]); }\n');
  await repo.write("src/orders/total.ts", "export const total = 1;\n");
  await repo.commit("init");
  await mkdir(repo.path("node_modules/.bin"), { recursive: true });
  await symlink(join(SELF, "node_modules/.bin/ast-grep"), repo.path("node_modules/.bin/ast-grep"));
});

afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

describe("metator patterns scan", () => {
  test("finds real occurrences, keeps legacy apart, writes a versioned index", async () => {
    const r = await metator(["patterns", "scan", "--check"], repo.root);
    expect(r.code).toBe(0);
    expect(data(r).patterns).toEqual([
      {
        id: "query-hook",
        title: "Query hook",
        exemplar: "src/orders/orders.queries.ts",
        occurrences: 2,
        byPackage: { shop: 2 },
        legacy: ["src/legacy/useFetch.ts"],
      },
    ]);
    expect(
      (await findUnversioned(repo.root, [".metator/index", "docs/metator/patterns"])).unversioned,
    ).toEqual([
      "docs/metator/patterns/sg-tests/mt-pattern-query-hook-test.yml",
      "docs/metator/patterns/sg/mt-pattern-query-hook.yml",
    ]); // tool-owned ast-grep files keep ast-grep's own format
  });

  test("--check fails when the exemplar stops being an occurrence", async () => {
    await repo.write("src/orders/orders.queries.ts", "export const orders = [];\n");
    try {
      const r = await metator(["patterns", "scan", "--check"], repo.root);
      expect(r.code).toBe(1);
      const problems = ((r.json.error as { details: Data }).details.problems as Data[]).map((p) => p.message);
      expect(problems).toEqual([
        "1 occurrence(s), expected at least 2",
        "exemplar src/orders/orders.queries.ts is not an occurrence of ast-grep:mt-pattern-query-hook",
      ]);
      expect((await metator(["patterns", "scan"], repo.root)).code).toBe(0); // without --check: report only
    } finally {
      await repo.git("checkout", "--", "src/orders/orders.queries.ts");
    }
  });

  test("hints never count as rule violations", async () => {
    const r = await metator(["rules", "check"], repo.root);
    expect([r.code, data(r).violations]).toEqual([0, []]);
  });
});

describe("metator similar", () => {
  test("a planned file gets the closest occurrence, the exemplar first, never legacy", async () => {
    const r = await metator(["similar", "--file", "src/orders/customers.queries.ts"], repo.root);
    expect(r.code).toBe(0);
    const matches = data(r).matches as Data[];
    expect(matches.map((m) => [m.file, m.exemplar])).toEqual([
      ["src/orders/orders.queries.ts", true],
      ["src/billing/invoices.queries.ts", false],
    ]);
  });

  test("a description works too; --top limits; no input is a usage error", async () => {
    const r = await metator(["similar", "fetch", "server", "data", "--top", "1"], repo.root);
    expect((data(r).matches as Data[]).map((m) => m.file)).toEqual(["src/orders/orders.queries.ts"]);
    expect((await metator(["similar"], repo.root)).code).toBe(64);
    expect((await metator(["similar", "x", "--top", "0"], repo.root)).code).toBe(64);
  });
});

describe("dogfood: MetatorAI's pattern catalog", () => {
  test("every pattern has a real exemplar and enough occurrences", async () => {
    const r = await metator(["patterns", "scan", "--check", "--root", SELF], SELF);
    expect(r.code).toBe(0);
    expect((data(r).patterns as Data[]).map((p) => p.id)).toEqual([
      "cli-command-group",
      "port-adapter",
      "use-case",
      "versioned-document",
    ]);
  });

  test("similar points a new use case at the use-case exemplar", async () => {
    const r = await metator(
      ["similar", "--file", "packages/core/src/application/new-thing.ts", "--root", SELF],
      SELF,
    );
    expect((data(r).matches as Data[])[0]).toMatchObject({ pattern: "use-case", exemplar: true });
  });
});
