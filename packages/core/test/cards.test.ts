import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { BuildModuleCards, cardFile } from "../src/application/cards.ts";
import type { ImportGraphReport } from "../src/application/import-graph.ts";
import { FindOwners } from "../src/application/owners.ts";
import { DEFAULT_PATHS, DEFAULT_TEST_GLOBS } from "../src/application/paths.ts";
import { PatternCatalog } from "../src/application/patterns.ts";
import { GENERATED_END, GENERATED_START, splitCard } from "../src/domain/module-card.ts";
import { ok } from "../src/domain/result.ts";

const REPORT: ImportGraphReport = {
  files: [
    "packages/money/src/index.ts",
    "packages/money/src/money.ts",
    "packages/money/src/money.test.ts",
    "packages/billing/src/invoice.ts",
    "apps/web/src/main.ts",
    "apps/web/src/main.test.ts",
  ],
  edges: [
    {
      from: "packages/money/src/money.test.ts",
      to: "packages/billing/src/invoice.ts",
      kind: "cross-package",
    },
    { from: "apps/web/src/main.test.ts", to: "packages/billing/src/invoice.ts", kind: "cross-package" },
    { from: "apps/web/src/main.test.ts", to: "packages/money/src/money.ts", kind: "cross-package" },
    { from: "packages/money/src/index.ts", to: "packages/money/src/money.ts", kind: "internal" },
    { from: "packages/billing/src/invoice.ts", to: "packages/money/src/index.ts", kind: "cross-package" },
    { from: "apps/web/src/main.ts", to: "packages/money/src/index.ts", kind: "cross-package" },
    { from: "apps/web/src/main.ts", to: "packages/billing/src/invoice.ts", kind: "cross-package" },
  ],
  packages: [
    { name: "@acme/money", dir: "packages/money" },
    { name: "@acme/billing", dir: "packages/billing" },
    { name: "@acme/web", dir: "apps/web" },
  ],
  externals: ["lodash", "node:fs"],
  externalUses: [
    { from: "apps/web/src/main.ts", name: "lodash" },
    { from: "apps/web/src/main.ts", name: "node:fs" },
    { from: "apps/web/src/main.test.ts", name: "playwright" },
  ],
  unresolved: [],
  stats: { parsed: 5, reused: 0, failed: 0 },
  parseErrors: [],
};

function world(files: Record<string, string> = {}, report = REPORT) {
  const fs = new InMemoryFileSystem(files);
  const cards = new BuildModuleCards(
    { execute: async () => ok(report) },
    fs,
    DEFAULT_PATHS,
    DEFAULT_TEST_GLOBS,
    new FindOwners(fs),
    new PatternCatalog(fs, DEFAULT_PATHS),
  );
  return { fs, cards };
}

const MONEY = "docs/metator/modules/acme-money.card.md";

describe("cardFile", () => {
  test("slug of the package name", () => {
    expect(cardFile("cards", "@acme/billing")).toBe("cards/acme-billing.card.md");
    expect(cardFile("cards", "My_Lib")).toBe("cards/my-lib.card.md");
  });
});

describe("BuildModuleCards", () => {
  test("new cards: versioned header, generated facts and curated skeleton", async () => {
    const w = world();
    expect((await w.cards.execute({ check: false }))._unsafeUnwrap().written).toEqual([
      MONEY,
      "docs/metator/modules/acme-billing.card.md",
      "docs/metator/modules/acme-web.card.md",
    ]);
    const text = (await w.fs.read(MONEY))._unsafeUnwrap();
    expect(text).toStartWith(
      '---\nkind: ModuleCard\nschemaVersion: 1\npackage: "@acme/money"\ndir: packages/money\n---\n',
    );
    expect(text).toContain("- Depends on: none");
    expect(text).toContain("- Test-only dependencies: `@acme/billing`\n");
    const billing = (await w.fs.read("docs/metator/modules/acme-billing.card.md"))._unsafeUnwrap();
    expect(billing).toContain("- Used by: `@acme/web`\n"); // money's test is not a user
    expect(text).toContain("- Used by: `@acme/billing`, `@acme/web`");
    expect(text).toContain("- Imported by other packages: `packages/money/src/index.ts`\n");
    expect(text).toContain("## Invariants");
    const web = (await w.fs.read("docs/metator/modules/acme-web.card.md"))._unsafeUnwrap();
    expect(web).toContain("- Depends on: `@acme/billing`, `@acme/money`");
    expect(web).toContain("- Third-party: `lodash`\n"); // builtins and test-only packages are not listed
    expect(web).toContain("- Test-only dependencies: none"); // already production dependencies
    expect(text).not.toContain("`packages/money/src/money.ts`"); // a test import is not public surface
  });

  test("owners from CODEOWNERS and the patterns whose exemplar lives in the package", async () => {
    const pattern = (id: string, exemplar: string) =>
      `kind: Pattern\nschemaVersion: 1\nid: ${id}\ntitle: Title\nintent: An intent sentence.\nwhen: when needed\ndetection: ast-grep:x\nexemplar: ${exemplar}\n`;
    const w = world({
      ".github/CODEOWNERS": "* @all\npackages/money/ @money-team @finance\n",
      "docs/metator/patterns/money.yml": pattern("money-value", "packages/money/src/money.ts"),
      "docs/metator/patterns/page.yml": pattern("page", "apps/web/src/main.ts"),
    });
    await w.cards.execute({ check: false });
    const money = (await w.fs.read(MONEY))._unsafeUnwrap();
    expect(money).toContain("- Owners: `@finance`, `@money-team`\n");
    expect(money).toContain("- Patterns with their exemplar here: `money-value`\n");
    const web = (await w.fs.read("docs/metator/modules/acme-web.card.md"))._unsafeUnwrap();
    expect(web).toContain("- Owners: `@all`\n");
    expect(web).toContain("- Patterns with their exemplar here: `page`\n");
  });

  test("without CODEOWNERS the card says so", async () => {
    const w = world();
    await w.cards.execute({ check: false });
    const money = (await w.fs.read(MONEY))._unsafeUnwrap();
    expect(money).toContain("- Owners: none (no CODEOWNERS)\n");
    expect(money).toContain("- Patterns with their exemplar here: none\n");
  });

  test("curated text survives regeneration; only the generated block changes", async () => {
    const w = world();
    await w.cards.execute({ check: false });
    const curated = (await w.fs.read(MONEY))
      ._unsafeUnwrap()
      .replace("TODO: what usually goes wrong here.", "Rounding: always Money.round.");
    await w.fs.write(MONEY, curated);
    const changed: ImportGraphReport = {
      ...REPORT,
      edges: REPORT.edges.filter((e) => !e.from.startsWith("apps/")),
    };
    const again = world({ [MONEY]: curated }, changed);
    await again.cards.execute({ check: false });
    const text = (await again.fs.read(MONEY))._unsafeUnwrap();
    expect(text).toContain("Rounding: always Money.round.");
    expect(text).toContain("- Used by: `@acme/billing`\n");
  });

  test("check mode: up to date passes; a hand edit inside the block or a missing card is stale; nothing is written", async () => {
    const w = world();
    await w.cards.execute({ check: false });
    expect((await w.cards.execute({ check: true }))._unsafeUnwrap().stale).toEqual([]);
    const text = (await w.fs.read(MONEY))._unsafeUnwrap();
    await w.fs.write(MONEY, text.replace("- Depends on: none", "- Depends on: everything"));
    const report = (await w.cards.execute({ check: true }))._unsafeUnwrap();
    expect(report.stale).toEqual([MONEY]);
    expect((await w.fs.read(MONEY))._unsafeUnwrap()).toContain("everything");
    expect((await world().cards.execute({ check: true }))._unsafeUnwrap().stale).toHaveLength(3);
  });

  test("a card with broken markers is reported invalid and never overwritten", async () => {
    const broken = `---\nkind: ModuleCard\nschemaVersion: 1\npackage: "@acme/money"\ndir: packages/money\n---\n# money\n${GENERATED_START}\nno end marker\n`;
    const w = world({ [MONEY]: broken });
    const report = (await w.cards.execute({ check: false }))._unsafeUnwrap();
    expect(report.invalid.map((i) => i.file)).toEqual([MONEY]);
    expect((await w.fs.read(MONEY))._unsafeUnwrap()).toBe(broken);
  });

  test("cards of removed packages are orphaned; other Markdown is ignored", async () => {
    const w = world({
      "docs/metator/modules/acme-gone.card.md": `---\nkind: ModuleCard\nschemaVersion: 1\npackage: "@acme/gone"\ndir: packages/gone\n---\n${GENERATED_START}${GENERATED_END}\n`,
      "docs/metator/modules/notes.card.md": "# just notes\n",
    });
    expect((await w.cards.execute({ check: false }))._unsafeUnwrap().orphaned).toEqual([
      "docs/metator/modules/acme-gone.card.md",
    ]);
  });
});

describe("splitCard", () => {
  test("requires the header and exactly one generated block", () => {
    const head = `---\nkind: ModuleCard\nschemaVersion: 1\npackage: p\ndir: d\n---\n`;
    expect(splitCard(`${head}${GENERATED_START}x${GENERATED_END}`, "c.md")._unsafeUnwrap().generated).toBe(
      "x",
    );
    expect(splitCard(`${head}no block`, "c.md").isErr()).toBe(true);
    expect(splitCard(`${head}${GENERATED_START}${GENERATED_START}${GENERATED_END}`, "c.md").isErr()).toBe(
      true,
    );
    expect(splitCard(`# no header ${GENERATED_START}${GENERATED_END}`, "c.md").isErr()).toBe(true);
  });
});
