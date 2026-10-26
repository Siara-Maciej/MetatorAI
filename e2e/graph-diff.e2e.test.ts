/**
 * `graph diff` end to end: the real `metator` process on a real Bun-workspaces monorepo with
 * real git history (merge base), real oxc parsing and resolution.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMonorepo } from "@metator/testing";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const MONEY = "packages/money/src";
let repo: ScratchRepo;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await createMonorepo(repo.root);
  await repo.commit("init");
  await repo.git("checkout", "-q", "-b", "feature");
}, 60_000);
afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;

describe("metator graph diff (real CLI, real git)", () => {
  test("no change since the base: nothing added or removed", async () => {
    const r = await metator(["graph", "diff", "--base", "main"], repo.root);
    expect([r.code, r.json.data]).toEqual([
      0,
      { base: "main", changed: 0, added: [], removed: [], newPackageDependencies: [], newCycles: [] },
    ]);
  });

  test("a changed import shows as edges, a new package dependency and the cycle it closes", async () => {
    await repo.write(
      `${MONEY}/money.ts`,
      'import { invoice } from "@acme/billing";\nexport const add = (a: number, b: number) => a + b + invoice.length;\n',
    );
    // A workspace package resolves only once it is declared (as `bun install` links it).
    const manifest = JSON.parse(await repo.read("packages/money/package.json")) as Data;
    await repo.write(
      "packages/money/package.json",
      JSON.stringify({ ...manifest, dependencies: { "@acme/billing": "workspace:*" } }, null, 2),
    );
    const install = Bun.spawn(["bun", "install", "--silent"], {
      cwd: repo.root,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await install.exited).toBe(0);
    await repo.commit("money uses billing");
    const data = (await metator(["graph", "diff", "--base", "main"], repo.root)).json.data as Data;
    expect(data.added).toEqual([
      { from: `${MONEY}/money.ts`, to: "packages/billing/src/invoice.ts", kind: "cross-package" },
    ]);
    expect(data.removed).toEqual([
      { from: `${MONEY}/money.ts`, to: `${MONEY}/currency.ts`, kind: "internal" },
    ]);
    expect(data.newPackageDependencies).toEqual([
      {
        from: "@acme/money",
        to: "@acme/billing",
        via: `${MONEY}/money.ts → packages/billing/src/invoice.ts`,
      },
    ]);
    expect(data.newCycles).toEqual([
      [`packages/billing/src/invoice.ts`, `${MONEY}/index.ts`, `${MONEY}/money.ts`],
    ]);
  });

  test("a file deleted on the branch loses all its edges", async () => {
    await repo.git("rm", "-q", `${MONEY}/money.test.ts`);
    const data = (await metator(["graph", "diff", "--base", "main"], repo.root)).json.data as Data;
    expect(data.removed).toContainEqual({
      from: `${MONEY}/money.test.ts`,
      to: `${MONEY}/money.ts`,
      kind: "internal",
    });
  });

  test("an unknown base is a usage error (exit 64)", async () => {
    const r = await metator(["graph", "diff", "--base", "no-such-branch"], repo.root);
    expect([r.code, (r.json.error as Data).code]).toEqual([64, "USAGE"]);
  });
});
