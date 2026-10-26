import { describe, expect, test } from "bun:test";
import { FakeVcs, InMemoryFileSystem } from "@metator/testing";
import { parse, stringify } from "yaml";
import { FindMemoryDupes, KnowledgeFiles, MemoryMapReader } from "../src/application/memory.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { SourceFiles } from "../src/application/source-files.ts";
import { findDuplicates, sentencesOf } from "../src/domain/dupes.ts";
import { accessMatrix, MemoryMapDocument } from "../src/domain/memory.ts";

const STATEMENT = "Every persisted file starts with kind and schemaVersion so readers know how to parse it.";

describe("sentencesOf", () => {
  test("prose only: no code, headings, tables, citations; links keep their text", () => {
    const md = [
      "# Every heading is a name and not a statement at all",
      `${STATEMENT} See [the ADR](adr/0016.md) [[cite: a.ts:1 | "x"]].`,
      "| Every table row lists things and is not a statement |",
      "```",
      "Code blocks contain examples rather than statements of fact here.",
      "```",
      "Short one.",
    ].join("\n");
    expect(sentencesOf("docs/a.md", md, 8).map((s) => [s.line, s.text])).toEqual([[2, STATEMENT]]);
  });

  test("Markdown front matter is metadata, not statements; line numbers stay true", () => {
    const md = `---\ndescription: ${STATEMENT}\n---\n# Title\n${STATEMENT}\n`;
    expect(sentencesOf("a.md", md, 8).map((s) => s.line)).toEqual([5]);
  });

  test("YAML: only prose fields count, structure is ignored", () => {
    const yaml = `summary: "${STATEMENT}"\nsource: { ref: AGENTS.md#conventions-and-many-more-words-here, verified: 2026-10-26 }\n`;
    expect(sentencesOf("rules/a.yml", yaml, 8).map((s) => s.line)).toEqual([1]);
  });
});

describe("findDuplicates", () => {
  const at = (file: string, text: string) => sentencesOf(file, text, 8);

  test("exact duplicates across files, case and punctuation insensitive", () => {
    const groups = findDuplicates(
      [...at("a.md", STATEMENT), ...at("b.md", STATEMENT.toUpperCase().replace(".", "!"))],
      0.8,
    );
    expect(groups.map((g) => [g.similarity, g.occurrences.map((o) => o.file)])).toEqual([
      [1, ["a.md", "b.md"]],
    ]);
  });

  test("near duplicates above the threshold; different statements and same-file repeats are not", () => {
    const near = STATEMENT.replace("readers know", "every reader knows");
    expect(findDuplicates([...at("a.md", STATEMENT), ...at("b.md", near)], 0.5)[0]?.similarity).toBeLessThan(
      1,
    );
    expect(findDuplicates([...at("a.md", STATEMENT), ...at("b.md", near)], 0.95)).toEqual([]);
    expect(findDuplicates([...at("a.md", STATEMENT), ...at("a.md", STATEMENT)], 0.8)).toEqual([]);
    expect(
      findDuplicates(
        [
          ...at("a.md", STATEMENT),
          ...at("b.md", "Run the formatter before every commit so diffs stay small and clean."),
        ],
        0.5,
      ),
    ).toEqual([]);
  });

  test("chains of similar sentences in three files form one group", () => {
    const groups = findDuplicates(
      [...at("a.md", STATEMENT), ...at("b.md", STATEMENT), ...at("c.md", STATEMENT)],
      0.8,
    );
    expect(groups.map((g) => g.occurrences.length)).toEqual([3]);
  });
});

const MAP = stringify({
  kind: "MemoryMap",
  schemaVersion: 1,
  items: [
    {
      id: "t0.agents",
      tier: "T0",
      kind: "canon",
      paths: ["AGENTS.md"],
      load: "always",
      writers: ["human"],
      readers: ["*"],
    },
    {
      id: "t1.adr",
      tier: "T1",
      kind: "canon",
      paths: ["docs/adr/*.md"],
      load: "explicit",
      writers: ["human", "mt-docs-curator(HITL)"],
      readers: ["*"],
    },
    {
      id: "t1.generated",
      tier: "T1",
      kind: "derived",
      paths: [".github/instructions/**"],
      load: "applyTo:<globs>",
      writers: ["metator rules adapters"],
      readers: ["copilot"],
    },
    {
      id: "t1.map",
      tier: "T1",
      kind: "canon",
      paths: ["docs/metator/**"],
      load: "explicit",
      writers: ["human"],
      readers: ["mt-scout"],
    },
  ],
});

describe("FindMemoryDupes", () => {
  test("canon wins as the place to keep; generated copies are not duplicates", async () => {
    const files = {
      "docs/metator/memory-map.yml": MAP,
      "AGENTS.md": `# A\n${STATEMENT}\n`,
      "docs/adr/0016-versioned.md": `# ADR\n${STATEMENT}\n`,
      ".github/instructions/mt-code.instructions.md": `${STATEMENT}\n`,
    };
    const fs = new InMemoryFileSystem(files);
    const find = new FindMemoryDupes(
      new MemoryMapReader(fs, DEFAULT_PATHS),
      new KnowledgeFiles(new SourceFiles(new FakeVcs(Object.keys(files)), fs, [])),
      fs,
    );
    const report = (await find.execute({ minWords: 8, threshold: 0.8 }))._unsafeUnwrap();
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.keep).toBe("docs/adr/0016-versioned.md");
    expect(report.groups[0]?.occurrences.map((o) => [o.file, o.tier])).toEqual([
      ["AGENTS.md", "T0"],
      ["docs/adr/0016-versioned.md", "T1"],
    ]);
  });
});

describe("accessMatrix", () => {
  test("readers * grant read to every agent; annotations are dropped; writers get W", () => {
    expect(MemoryMapDocument.parse({ kind: "MemoryMap", schemaVersion: 1, items: [] }, "m.yml").isErr()).toBe(
      true,
    );
    const parsed = MemoryMapDocument.parse(parse(MAP), "m.yml")._unsafeUnwrap();
    const m = accessMatrix(parsed);
    expect(m.agents).toEqual(["copilot", "human", "metator rules adapters", "mt-docs-curator", "mt-scout"]);
    expect(m.access["mt-docs-curator"]).toEqual({ "t0.agents": "R", "t1.adr": "RW" });
    expect(m.access["metator rules adapters"]).toEqual({
      "t0.agents": "R",
      "t1.adr": "R",
      "t1.generated": "W",
    });
    expect(m.markdown.split("\n")[0]).toBe("| Agent | t0.agents | t1.adr | t1.generated | t1.map |");
  });
});
