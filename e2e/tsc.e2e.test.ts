/** tsc as an E1 engine end to end: real `metator`, real git repo, real TypeScript compiler. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
const TSCONFIG = (on: boolean) =>
  JSON.stringify({
    compilerOptions: { strict: true, noUncheckedIndexedAccess: on, noEmit: true },
    include: ["src"],
  });
const RULES = `kind: RuleSet
schemaVersion: 1
area: TS
rules:
  - id: ACME-TS-001
    title: Lookups may be undefined
    applyTo: ["src/**"]
    enforcement: E1
    implementation: tsc:noUncheckedIndexedAccess
    summary: Array lookups are typed as possibly undefined.
    rationale: README.md
    source: { ref: tsconfig.json, verified: 2026-10-26 }
`;

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", "node_modules/\n.metator/\n");
  await repo.write("README.md", "# acme\n");
  await repo.write("tsconfig.json", TSCONFIG(true));
  await repo.write("docs/metator/rules/ts.yml", RULES);
  await repo.write("src/a.ts", "const xs: number[] = [1];\nexport const first = xs[0] ?? 0;\n");
  await repo.commit("init");
  await mkdir(repo.path("node_modules/.bin"), { recursive: true });
  await symlink(join(SELF, "node_modules/.bin/tsc"), repo.path("node_modules/.bin/tsc"));
});
afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;

describe("tsc as an E1 engine", () => {
  test("a rule bound to a compiler flag holds while the flag is on; turning it off fails the lint", async () => {
    expect((await metator(["rules", "lint"], repo.root)).code).toBe(0);
    await repo.write("tsconfig.json", TSCONFIG(false));
    try {
      const r = await metator(["rules", "lint"], repo.root);
      expect(r.code).toBe(1);
      expect(JSON.stringify((r.json.error as Data).details)).toContain(
        "tsc:noUncheckedIndexedAccess is not enabled",
      );
    } finally {
      await repo.write("tsconfig.json", TSCONFIG(true));
    }
  });

  test("type errors are violations of the tsc engine; a clean project passes", async () => {
    expect((await metator(["rules", "check"], repo.root)).code).toBe(0);
    await repo.write("src/a.ts", "const xs: number[] = [1];\nexport const first: number = xs[0];\n");
    try {
      const r = await metator(["rules", "check"], repo.root);
      expect(r.code).toBe(1);
      const v = ((r.json.error as { details: Data }).details.violations as Data[])[0];
      expect([v?.engine, v?.toolRuleId, v?.file, v?.line]).toEqual(["tsc", "TS2322", "src/a.ts", 2]);
    } finally {
      await repo.git("checkout", "--", "src/a.ts");
    }
  });
});
