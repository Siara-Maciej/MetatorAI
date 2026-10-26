/** Module cards end to end: the real `metator` process on a real Bun-workspaces monorepo. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createMonorepo } from "@metator/testing";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const SELF = join(import.meta.dir, "..");
const WEB = "docs/metator/modules/acme-web.card.md";
let repo: ScratchRepo;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await createMonorepo(repo.root);
  await repo.commit("init");
}, 60_000);

afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const details = (r: { json: Record<string, unknown> }) => (r.json.error as { details: Data }).details;

describe("metator cards build", () => {
  test("one versioned card per workspace package, facts from the real import graph", async () => {
    const r = await metator(["cards", "build"], repo.root);
    expect(r.code).toBe(0);
    expect([...(data(r).written as string[])].sort()).toEqual([
      "docs/metator/modules/acme-billing.card.md",
      "docs/metator/modules/acme-money.card.md",
      WEB,
    ]);
    const web = await repo.read(WEB);
    expect(web).toContain("- Depends on: `@acme/billing`\n");
    expect(web).toContain("- Third-party: `lodash`\n");
    const money = await repo.read("docs/metator/modules/acme-money.card.md");
    expect(money).toContain("- Used by: `@acme/billing`\n");
    expect(money).toContain("- Imported by other packages: `packages/money/src/index.ts`\n");
    expect((await findUnversioned(repo.root, ["docs/metator"])).unversioned).toEqual([]);
    expect((await metator(["cards", "build", "--check"], repo.root)).code).toBe(0);
  });

  test("an architecture change makes cards stale; rebuilding keeps the curated text", async () => {
    await metator(["cards", "build"], repo.root);
    await repo.write(
      WEB,
      (await repo.read(WEB)).replace("TODO: what usually goes wrong here.", "Prices are cents."),
    );
    const main = await repo.read("apps/web/src/main.ts");
    const manifest = await repo.read("apps/web/package.json");
    await repo.write(
      "apps/web/src/main.ts",
      `import { add } from "@acme/money";\n${main}export const sum = add;\n`,
    );
    await repo.write(
      "apps/web/package.json",
      JSON.stringify({
        name: "@acme/web",
        private: true,
        dependencies: { "@acme/billing": "workspace:*", "@acme/money": "workspace:*" },
      }),
    );
    const install = Bun.spawn(["bun", "install", "--silent"], {
      cwd: repo.root,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await install.exited).toBe(0);
    try {
      const check = await metator(["cards", "build", "--check"], repo.root);
      // Both ends of the new edge change: web depends on money, money is used by web.
      expect([check.code, [...(details(check).stale as string[])].sort()]).toEqual([
        1,
        ["docs/metator/modules/acme-money.card.md", WEB],
      ]);
      expect((await metator(["cards", "build"], repo.root)).code).toBe(0);
      const web = await repo.read(WEB);
      expect(web).toContain("- Depends on: `@acme/billing`, `@acme/money`\n");
      expect(web).toContain("Prices are cents.");
    } finally {
      await repo.write("apps/web/src/main.ts", main);
      await repo.write("apps/web/package.json", manifest);
      await metator(["cards", "build"], repo.root);
    }
  });

  test("a card with a broken generated block is reported and never overwritten", async () => {
    const before = await repo.read(WEB);
    const broken = before.replace("<!-- metator:generated:end -->", "");
    await repo.write(WEB, broken);
    try {
      const r = await metator(["cards", "build"], repo.root);
      expect(r.code).toBe(1);
      expect((details(r).invalid as Data[]).map((i) => i.file)).toEqual([WEB]);
      expect(await repo.read(WEB)).toBe(broken);
    } finally {
      await repo.write(WEB, before);
    }
  });
});

describe("dogfood: MetatorAI's module cards", () => {
  test("cards are up to date and their curated citations are true", async () => {
    expect((await metator(["cards", "build", "--check", "--root", SELF], SELF)).code).toBe(0);
    const v = await metator(["memory", "validate", "--root", SELF], SELF);
    expect([v.code, (data(v).counts as Data).ok]).toEqual([0, 11]);
  });
});
