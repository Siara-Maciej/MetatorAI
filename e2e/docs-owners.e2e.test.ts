/** `owners` and `docs inventory|links|drift` end to end: real `metator` processes on a real git repository. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
const CLAIMS = (line: number) =>
  JSON.stringify({
    kind: "ClaimSet",
    schemaVersion: 1,
    claims: [
      {
        id: "tax.rate",
        source: "docs/guide.md",
        statement: "The tax rate is a constant.",
        status: "verified",
        evidence: { path: "src/tax.ts", line, quote: "export const TAX = 0.23;" },
      },
    ],
  });

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".github/CODEOWNERS", "* @everyone\n/docs/ @writers\n");
  await repo.write("README.md", "# App\n\nRead [the guide](docs/guide.md#install).\n");
  await repo.write("docs/guide.md", "# Guide\n\n## Install\n\nBack to [the readme](../README.md).\n");
  await repo.write("src/tax.ts", "// rates\nexport const TAX = 0.23;\n");
  await repo.write("docs/metator/claims.json", CLAIMS(2));
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator owners (real CLI)", () => {
  test("the last matching CODEOWNERS line decides", async () => {
    const r = await metator(["owners", "docs/guide.md", "src/tax.ts"], repo.root);
    expect([r.code, r.json.data]).toEqual([
      0,
      {
        source: ".github/CODEOWNERS",
        owners: [
          { path: "docs/guide.md", owners: ["@writers"], rule: { pattern: "/docs/", line: 2 } },
          { path: "src/tax.ts", owners: ["@everyone"], rule: { pattern: "*", line: 1 } },
        ],
      },
    ]);
  });
});

describe("metator docs (real CLI)", () => {
  test("inventory: documents with their git date, owners and links", async () => {
    const r = await metator(["docs", "inventory"], repo.root);
    const docs = (
      r.json.data as { documents: { path: string; owners: string[]; links: number; lastChanged?: string }[] }
    ).documents;
    expect(docs.map((d) => [d.path, d.owners, d.links, typeof d.lastChanged])).toEqual([
      ["README.md", ["@everyone"], 1, "string"],
      ["docs/guide.md", ["@writers"], 1, "string"],
    ]);
  });

  test("links: a renamed heading and a deleted file are dead links", async () => {
    expect((await metator(["docs", "links"], repo.root)).code).toBe(0);
    await repo.write(
      "docs/guide.md",
      "# Guide\n\n## Setup\n\nBack to [the readme](../README.md) or [old](old.md).\n",
    );
    try {
      const r = await metator(["docs", "links"], repo.root);
      expect(r.code).toBe(1);
      expect((r.json.error as { details: { dead: unknown[] } }).details.dead).toEqual([
        { file: "README.md", line: 3, target: "docs/guide.md#install", reason: "missing-anchor" },
        { file: "docs/guide.md", line: 5, target: "old.md", reason: "missing-file" },
      ]);
    } finally {
      await repo.write("docs/guide.md", "# Guide\n\n## Install\n\nBack to [the readme](../README.md).\n");
    }
  });

  test("drift: a moved quote fails until --fix; a changed quote is drift", async () => {
    expect((await metator(["docs", "drift"], repo.root)).code).toBe(0);
    await repo.write("src/tax.ts", "// rates\n// changed\nexport const TAX = 0.23;\n");
    const moved = await metator(["docs", "drift"], repo.root);
    expect([moved.code, (moved.json.error as { message: string }).message]).toEqual([
      1,
      "0 drifted, 1 moved",
    ]);
    expect((await metator(["docs", "drift", "--fix"], repo.root)).code).toBe(0);
    expect(JSON.parse(await repo.read("docs/metator/claims.json")).claims[0].evidence.line).toBe(3);
    expect((await metator(["docs", "drift"], repo.root)).code).toBe(0);

    await repo.write("src/tax.ts", "export const TAX = 0.21;\n");
    const drift = await metator(["docs", "drift"], repo.root);
    expect([drift.code, (drift.json.error as { message: string }).message]).toEqual([
      1,
      "1 drifted, 0 moved",
    ]);
    await repo.write("src/tax.ts", "// rates\nexport const TAX = 0.23;\n");
    await repo.write("docs/metator/claims.json", CLAIMS(2));
  }, 60_000); // six CLI processes

  test("claims-schema prints the JSON Schema of the claims file", async () => {
    const r = await metator(["docs", "claims-schema"], repo.root);
    expect([r.code, Object.keys((r.json.data as { properties: object }).properties)]).toEqual([
      0,
      ["kind", "schemaVersion", "claims"],
    ]);
  });

  test("dogfood: MetatorAI has no dead links and no drifted claims", async () => {
    for (const args of [
      ["docs", "links"],
      ["docs", "drift"],
    ]) {
      const r = await metator([...args, "--root", SELF], SELF);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), 0]);
    }
  }, 60_000);
});
