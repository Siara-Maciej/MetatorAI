import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { stringify } from "yaml";
import { LintAdrs } from "../src/application/adrs.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RuleCatalog } from "../src/application/rules.ts";
import { hasSection, parseAdr, sameHeading } from "../src/domain/adr.ts";

const adr = (n: string, status: string, extra = "", lang: "pl" | "en" = "pl") =>
  [
    `# ADR-${n}: Title ${n}`,
    "",
    `- Status: ${status}`,
    "- Data: 2026-10-26",
    "",
    lang === "pl"
      ? "## Kontekst\nx\n\n## Decyzja\ny\n\n## Konsekwencje\nz\n"
      : "## Context\nx\n\n## Decision\ny\n\n## Consequences\nz\n",
    extra,
  ].join("\n");

const RULES = stringify({
  kind: "RuleSet",
  schemaVersion: 1,
  area: "ARCH",
  rules: [
    {
      id: "MT-ARCH-001",
      title: "Domain is pure",
      applyTo: ["src/**"],
      enforcement: "E2",
      summary: "Domain code does no I/O at all.",
      rationale: "docs/adr/0001-a.md",
      source: { ref: "docs/adr/0001-a.md", verified: "2026-10-26" },
    },
  ],
});

const INDEX = (rows: string[]) => `# ADR\n\n| ADR | Title | Status |\n|---|---|---|\n${rows.join("\n")}\n`;

async function lint(files: Record<string, string>) {
  const fs = new InMemoryFileSystem({ "docs/metator/rules/arch.yml": RULES, ...files });
  const report = (
    await new LintAdrs(fs, DEFAULT_PATHS, new RuleCatalog(fs, DEFAULT_PATHS)).execute()
  )._unsafeUnwrap();
  return {
    report,
    messages: report.problems.map((p) => `${p.file.replace("docs/adr/", "")}: ${p.severity}: ${p.message}`),
  };
}

describe("parseAdr", () => {
  test("title, status, superseding ADR, date, sections and rule ids outside code", () => {
    const parsed = parseAdr(
      adr(
        "0002",
        "Superseded by [ADR-0011](0011-di-awilix.md)",
        "## Implikacje dla kodu\n- MT-ARCH-001\n\n```\nMT-FAKE-999\n```\n",
      ),
    );
    expect(parsed).toMatchObject({
      number: 2,
      title: "Title 0002",
      status: "Superseded",
      statusRefs: [11],
      date: "2026-10-26",
      sections: ["Kontekst", "Decyzja", "Konsekwencje", "Implikacje dla kodu"],
      ruleRefs: ["MT-ARCH-001"],
      implicationRuleRefs: ["MT-ARCH-001"],
    });
  });
});

describe("LintAdrs", () => {
  test("a healthy log in Polish and English, with an index", async () => {
    const { report, messages } = await lint({
      "docs/adr/0001-a.md": adr(
        "0001",
        "Accepted",
        "## Implikacje dla kodu\n- MT-ARCH-001: domain is pure\n",
      ),
      "docs/adr/0002-b.md": adr("0002", "Superseded by ADR-0001", "", "en"),
      "docs/adr/README.md": INDEX([
        "| [0001](0001-a.md) | A | Accepted |",
        "| [0002](0002-b.md) | B | Superseded by 0001 |",
      ]),
    });
    expect(messages).toEqual([]);
    expect(report).toMatchObject({ adrs: 2, byStatus: { Accepted: 1, Superseded: 1 } });
  });

  test("file name, title, status, date and sections", async () => {
    const { messages } = await lint({
      "docs/adr/bad name.md": "# x",
      "docs/adr/0003-c.md": "# ADR-0004: Wrong number\n\n- Status: Maybe\n\n## Kontekst\n",
    });
    expect(messages).toEqual([
      "0003-c.md: error: title says ADR-4, file name says 0003",
      '0003-c.md: error: missing or unknown status (expected "- Status: Proposed | Accepted | Deprecated | Superseded by ADR-NNNN")',
      '0003-c.md: warning: missing "- Date: YYYY-MM-DD"',
      '0003-c.md: error: missing section "## Decision" or "## Decyzja"',
      '0003-c.md: error: missing section "## Consequences" or "## Konsekwencje"',
      "bad name.md: error: file name must be NNNN-short-title.md",
    ]);
  });

  test("Accepted ADRs must name the canon rules they imply; unknown rule ids fail", async () => {
    const { messages } = await lint({
      "docs/adr/0001-a.md": adr("0001", "Accepted"),
      "docs/adr/0002-b.md": adr("0002", "Accepted", "## Implications for code\nnothing yet\n"),
      "docs/adr/0003-c.md": adr("0003", "Proposed", "Implies MT-ARCH-404."),
    });
    expect(messages).toEqual([
      '0001-a.md: error: Accepted ADRs need "## Implications for code" or "## Implikacje dla kodu" naming the rules they imply',
      "0002-b.md: error: the implications section names no canon rule id",
      "0003-c.md: error: references unknown rule MT-ARCH-404",
    ]);
  });

  test("superseded by a missing ADR, duplicate numbers", async () => {
    const { messages } = await lint({
      "docs/adr/0001-a.md": adr("0001", "Superseded by ADR-0042"),
      "docs/adr/0002-b.md": adr("0002", "Proposed"),
      "docs/adr/0002-c.md": adr("0002", "Proposed"),
      "docs/adr/0003-d.md": adr("0003", "Superseded"),
    });
    expect(messages).toEqual([
      "0002-c.md: error: number 0002 is already used by docs/adr/0002-b.md",
      "0001-a.md: error: superseded by ADR-0042, which does not exist",
      "0003-d.md: error: superseded by which ADR? name it",
    ]);
  });

  test("the index must link every ADR with its current status, and only existing ones", async () => {
    const { messages } = await lint({
      "docs/adr/0001-a.md": adr("0001", "Accepted", "## Implikacje dla kodu\nMT-ARCH-001\n"),
      "docs/adr/0002-b.md": adr("0002", "Proposed"),
      "docs/adr/README.md": INDEX([
        "| [0001](0001-a.md) | A | Proposed |",
        "| [0009](0009-gone.md) | Gone | Proposed |",
      ]),
    });
    expect(messages).toEqual([
      "README.md: error: row for 0001-a.md does not show its status Accepted",
      "README.md: error: does not link 0002-b.md",
      "README.md: error: links 0009-gone.md, which does not exist",
    ]);
  });
});

describe("sameHeading", () => {
  test("ignores case and surrounding space", () => {
    expect(sameHeading("Implications for code", "  implications FOR code ")).toBe(true);
    expect(sameHeading("Decision", "Decisions")).toBe(false);
    expect(
      hasSection(parseAdr(adr("0003", "Proposed", "## KONTEKST DODATKOWY\n")), ["kontekst dodatkowy"]),
    ).toBe(true);
  });
});
