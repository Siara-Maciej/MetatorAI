/** Biome as an E1 engine end to end: real `metator`, real git repo, real Biome. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
const RULES = (implementation: string) => `kind: RuleSet
schemaVersion: 1
area: TS
rules:
  - id: ACME-TS-001
    title: No debugger statements
    applyTo: ["src/**"]
    enforcement: E1
    implementation: ${implementation}
    summary: Debugger statements never reach the main branch.
    rationale: README.md
    source: { ref: README.md, verified: 2026-10-26 }
`;

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", "node_modules/\n.metator/\n");
  await repo.write("README.md", "# acme\n");
  await repo.write(
    "biome.json",
    JSON.stringify({ vcs: { enabled: true, clientKind: "git", useIgnoreFile: true } }),
  );
  await repo.write("docs/metator/rules/ts.yml", RULES("biome:lint/suspicious/noDebugger"));
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.commit("init");
  await mkdir(repo.path("node_modules/@biomejs"), { recursive: true });
  await mkdir(repo.path("node_modules/.bin"), { recursive: true });
  await symlink(join(SELF, "node_modules/@biomejs/biome"), repo.path("node_modules/@biomejs/biome"));
  await symlink(join(SELF, "node_modules/.bin/biome"), repo.path("node_modules/.bin/biome"));
});
afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;

describe("Biome as an E1 engine", () => {
  test("rules lint verifies the Biome rule exists; a typo fails", async () => {
    expect((await metator(["rules", "lint"], repo.root)).code).toBe(0);
    await repo.write("docs/metator/rules/ts.yml", RULES("biome:lint/suspicious/noDebuger"));
    try {
      const r = await metator(["rules", "lint"], repo.root);
      expect(r.code).toBe(1);
      expect(JSON.stringify((r.json.error as Data).details)).toContain(
        "biome:lint/suspicious/noDebuger does not exist",
      );
    } finally {
      await repo.write("docs/metator/rules/ts.yml", RULES("biome:lint/suspicious/noDebugger"));
    }
  });

  test("rules check maps a Biome finding on a changed file to the canon rule", async () => {
    await repo.write("src/a.ts", "debugger;\nexport const a = 1;\n");
    try {
      const r = await metator(["rules", "check", "--base", "HEAD"], repo.root);
      expect(r.code).toBe(1);
      const violations = (r.json.error as { details: Data }).details.violations as Data[];
      expect(violations.map((v) => [v.engine, v.canonRuleId, v.file, v.line])).toEqual([
        ["biome", "ACME-TS-001", "src/a.ts", 1],
      ]);
    } finally {
      await repo.git("checkout", "--", "src/a.ts");
    }
    expect((await metator(["rules", "check"], repo.root)).code).toBe(0);
  });

  test("dogfood: every MetatorAI rule engine holds on this repository", async () => {
    const r = await metator(["rules", "check", "--root", SELF], SELF);
    expect([r.code, (r.json.data as Data).engines]).toEqual([0, ["ast-grep", "biome", "tsc", "test"]]);
  });
});
