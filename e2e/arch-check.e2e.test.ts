/**
 * `metator arch init|check|baseline` end to end (H2): a real monorepo whose Turborepo boundaries
 * become the first policy; a branch that closes a cycle fails `arch check --base main` and the
 * gate, with a SARIF log; the baseline accepts it, and tightening drops it once fixed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const CONFIG = `kind: MetatorConfig
schemaVersion: 3
gates:
  full:
    - id: packages
      run: { metator: arch check }
`;

let repo: ScratchRepo;
const mt = (...args: string[]) => metator(args, repo.root);
type Failure = { code: string; details: { failing: { id: string }[]; added: { id: string }[] } };

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nnode_modules/\n");
  await repo.write(
    "package.json",
    json({ name: "shop", private: true, workspaces: ["apps/*", "packages/*"] }),
  );
  await repo.write(
    "turbo.json",
    '{\n  // boundaries since Turborepo 2.4\n  "boundaries": { "tags": { "type:core": { "dependencies": { "deny": ["type:feature"] } } } }\n}\n',
  );
  await repo.write("metator.config.yml", CONFIG);
  await repo.write("apps/web/package.json", json({ name: "@shop/web", dependencies: { "@shop/cart": "*" } }));
  await repo.write(
    "apps/web/src/index.ts",
    'import { cart } from "@shop/cart";\nexport const page = cart;\n',
  );
  await repo.write(
    "packages/cart/package.json",
    json({ name: "@shop/cart", main: "src/index.ts", dependencies: { "@shop/pricing": "*" } }),
  );
  await repo.write("packages/cart/turbo.json", json({ tags: ["type:feature"] }));
  await repo.write(
    "packages/cart/src/index.ts",
    'import { price } from "@shop/pricing";\nexport const cart = price;\n',
  );
  await repo.write("packages/pricing/package.json", json({ name: "@shop/pricing", main: "src/index.ts" }));
  await repo.write("packages/pricing/turbo.json", json({ tags: ["type:core"] }));
  await repo.write("packages/pricing/src/index.ts", "export const price = 1;\n");
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator arch check (real CLI, real monorepo)", () => {
  test("init proposes a policy from the packages and turbo.json, once", async () => {
    const run = await mt("arch", "init");
    expect(run.code).toBe(0);
    expect((run.json.data as { notes: string[] }).notes[1]).toBe("1 rule(s) imported from turbo.json.");
    const text = await repo.read("metator/architecture.yml");
    expect(text).toContain('  - name: apps\n    packages:\n      - "@shop/web"');
    expect(text).toContain("  - from: type:core\n    deny:\n      - type:feature");
    const again = await mt("arch", "init");
    expect([again.code, (again.json.error as { code: string }).code]).toEqual([64, "USAGE"]);
    expect((await mt("arch", "check")).code).toBe(0);
    await repo.commit("policy");
  }, 60_000);

  test("a branch that closes a cycle fails the check against main, with SARIF, and fails the gate", async () => {
    await repo.git("checkout", "-q", "-b", "feature");
    await repo.write(
      "packages/pricing/package.json",
      json({ name: "@shop/pricing", main: "src/index.ts", dependencies: { "@shop/cart": "*" } }),
    );
    await repo.write(
      "packages/pricing/src/index.ts",
      'import { cart } from "@shop/cart";\nexport const price = 1;\nexport const again = () => cart;\n',
    );
    const run = await mt("arch", "check", "--base", "main", "--sarif", "out/arch.sarif");
    expect(run.code).toBe(1);
    const error = run.json.error as Failure;
    expect(error.code).toBe("CHECK_FAILED");
    expect(error.details.failing.map((v) => v.id)).toEqual([
      "cycle:@shop/cart,@shop/pricing",
      "tag:@shop/pricing→@shop/cart",
    ]);
    const sarif = JSON.parse(await repo.read("out/arch.sarif"));
    expect(sarif.runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toEqual([
      "arch/cycle",
      "arch/tag",
    ]);

    const gate = await mt("gate", "full", "--base", "main");
    expect(gate.code).toBe(1);
    const steps = (
      gate.json.error as { details: { steps: { id: string; status: string; detail?: string }[] } }
    ).details.steps;
    expect(steps.map((s) => `${s.id}:${s.status}`)).toEqual(["packages:fail"]);
    expect(steps[0]?.detail).toContain("cycle:@shop/cart,@shop/pricing");
  }, 90_000);

  test("the baseline accepts what is there; tightening drops it once fixed", async () => {
    const accepted = await mt("arch", "baseline");
    expect(accepted.json.data).toEqual({ file: "metator/arch-baseline.json", violations: 2, dropped: 0 });
    const check = await mt("arch", "check", "--base", "main");
    expect(check.code).toBe(0);
    expect((check.json.data as { baseline: string }).baseline).toBe("metator/arch-baseline.json");

    await repo.write("packages/pricing/src/index.ts", "export const price = 1;\n");
    const fixed = await mt("arch", "check");
    expect((fixed.json.data as { fixed: string[] }).fixed).toEqual([
      "cycle:@shop/cart,@shop/pricing",
      "tag:@shop/pricing→@shop/cart",
    ]);
    const tight = await mt("arch", "baseline", "--tighten");
    expect(tight.json.data).toEqual({ file: "metator/arch-baseline.json", violations: 0, dropped: 2 });
  }, 90_000);
});

describe("metator arch check after a rename (real CLI)", () => {
  test("renaming a file inside a cycle adds nothing: the base resolves its own files", async () => {
    const r = await ScratchRepo.create();
    try {
      await r.write(".gitignore", ".metator/\nnode_modules/\n");
      await r.write("package.json", json({ name: "w", private: true, workspaces: ["packages/*"] }));
      await r.write(
        "packages/a/package.json",
        json({ name: "@w/a", main: "src/index.ts", dependencies: { "@w/b": "*" } }),
      );
      await r.write(
        "packages/a/src/index.ts",
        'import { x } from "../../b/src/x.ts";\nexport const a = x;\n',
      );
      await r.write(
        "packages/b/package.json",
        json({ name: "@w/b", main: "src/x.ts", dependencies: { "@w/a": "*" } }),
      );
      await r.write(
        "packages/b/src/x.ts",
        'import { a } from "../../a/src/index.ts";\nexport const x = 1;\nexport const y = () => a;\n',
      );
      await r.commit("a cycle");
      await r.git("checkout", "-q", "-b", "rename");
      await r.git("mv", "packages/b/src/x.ts", "packages/b/src/y.ts");
      await r.write(
        "packages/a/src/index.ts",
        'import { x } from "../../b/src/y.ts";\nexport const a = x;\n',
      );
      await r.write(
        "packages/b/package.json",
        json({ name: "@w/b", main: "src/y.ts", dependencies: { "@w/a": "*" } }),
      );
      const check = await metator(["arch", "check", "--base", "main"], r.root);
      expect([check.code, (check.json.data as { failing: unknown[] }).failing]).toEqual([0, []]);
    } finally {
      await r.dispose();
    }
  }, 90_000);
});
