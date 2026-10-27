/**
 * `api snapshot|diff` end to end: the real `metator` process with the real TypeScript compiler
 * on a real workspace package.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
const MONEY = `/** Money in cents. */
export class Money {
  private readonly cents: number;
  constructor(cents: number) {
    this.cents = cents;
  }
  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }
}
`;

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", "node_modules/\n.metator/\n");
  await repo.write(
    "package.json",
    JSON.stringify({ name: "acme", private: true, workspaces: ["packages/*"] }),
  );
  await repo.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "preserve",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        noEmit: true,
      },
      include: ["packages"],
    }),
  );
  await repo.write(
    "packages/money/package.json",
    JSON.stringify({ name: "@acme/money", exports: { ".": "./src/index.ts" } }),
  );
  await repo.write("packages/money/src/index.ts", 'export * from "./money.ts";\n');
  await repo.write("packages/money/src/money.ts", MONEY);
  await repo.commit("init");
  await mkdir(repo.path("node_modules/.bin"), { recursive: true });
  await symlink(join(SELF, "node_modules/.bin/tsc"), repo.path("node_modules/.bin/tsc"));
});
afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;

describe("metator api snapshot / diff (real tsc)", () => {
  test("snapshot keeps the declarations the entry reaches, without private members or comments", async () => {
    const r = await metator(["api", "snapshot", "@acme/money"], repo.root);
    expect(r.code).toBe(0);
    const files = (r.json.data as { files: { path: string; lines: string[] }[] }).files;
    expect(files.map((f) => f.path)).toEqual([
      "packages/money/src/index.d.ts",
      "packages/money/src/money.d.ts",
    ]);
    const money = files[1]?.lines ?? [];
    expect(money).toContain("add(other: Money): Money;");
    expect(money.some((l) => l.includes("cents;") || l.includes("Money in cents"))).toBe(false);
    const saved = JSON.parse(await repo.read(".metator/api/acme__money.json")) as Data;
    expect([saved.kind, saved.schemaVersion]).toEqual(["ApiSnapshot", 1]);
  }, 60_000);

  test("a refactor of private code keeps the API; a signature change fails the diff", async () => {
    await repo.write(
      "packages/money/src/money.ts",
      MONEY.replace("private readonly cents: number;", "private readonly cents: number; // renamed later"),
    );
    expect((await metator(["api", "diff", "@acme/money"], repo.root)).json.data).toMatchObject({
      changed: false,
    });

    await repo.write(
      "packages/money/src/money.ts",
      MONEY.replace("add(other: Money): Money {", "add(other: Money, times = 1): Money {"),
    );
    const r = await metator(["api", "diff", "@acme/money"], repo.root);
    expect(r.code).toBe(1);
    const details = (
      r.json.error as { details: { files: { path: string; added: string[]; removed: string[] }[] } }
    ).details;
    expect(details.files).toEqual([
      {
        path: "packages/money/src/money.d.ts",
        added: ["add(other: Money, times?: number): Money;"],
        removed: ["add(other: Money): Money;"],
      },
    ]);
    await repo.git("checkout", "--", "packages/money/src/money.ts");
  }, 60_000);

  test("without a package it snapshots every workspace package (a refactor's snapshot stage)", async () => {
    const r = await metator(["api", "snapshot"], repo.root);
    const names = (r.json.data as { snapshots: { package: string }[] }).snapshots.map((x) => x.package);
    expect([r.code, names]).toEqual([0, ["@acme/money"]]);
  }, 60_000);

  test("an unknown package is NOT_FOUND with the known ones; diff without a snapshot says how to take one", async () => {
    const unknown = await metator(["api", "snapshot", "@acme/nope"], repo.root);
    expect((unknown.json.error as { details: { known: string[] } }).details.known).toContain("@acme/money");
    const fresh = await ScratchRepo.create();
    try {
      await fresh.write("package.json", JSON.stringify({ name: "solo" }));
      const r = await metator(["api", "diff", "solo"], fresh.root);
      expect((r.json.error as { hint: string }).hint).toContain("metator api snapshot solo");
    } finally {
      await fresh.dispose();
    }
  });
});
