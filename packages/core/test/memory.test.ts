import { describe, expect, test } from "bun:test";
import { FakeVcs, InMemoryFileSystem } from "@metator/testing";
import { stringify } from "yaml";
import {
  CheckMemory,
  InventoryMemory,
  KnowledgeFiles,
  MemoryBudget,
  MemoryMapReader,
  ValidateCitations,
} from "../src/application/memory.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { SourceFiles } from "../src/application/source-files.ts";
import {
  locateQuote,
  MemoryMapDocument,
  overBudget,
  parseCitations,
  renderCitation,
  sizeOf,
} from "../src/domain/memory.ts";

describe("citations", () => {
  test("parse path, line, quote (with escaped quotes) and position", () => {
    const text =
      'Intro\nAmounts [[cite: src/a.ts:3 | "if (x < 0) throw"]] and [[cite: b.ts:1|"say \\"hi\\""]].\n';
    expect(parseCitations(text).map(({ path, line, quote, at }) => ({ path, line, quote, at }))).toEqual([
      { path: "src/a.ts", line: 3, quote: "if (x < 0) throw", at: 2 },
      { path: "b.ts", line: 1, quote: 'say "hi"', at: 2 },
    ]);
  });

  test("in Markdown, citations inside code blocks and code spans are examples, not claims", () => {
    const md = [
      'Real [[cite: a.ts:1 | "x"]].',
      "```md",
      '[[cite: example.ts:41 | "if (amount < 0) throw"]]',
      "```",
      'Inline `[[cite: span.ts:1 | "y"]]` and ``[[cite: double.ts:1 | "z"]]``.',
      'After [[cite: b.ts:2 | "w"]].',
    ].join("\n");
    expect(parseCitations(md, { markdown: true }).map((c) => [c.path, c.at])).toEqual([
      ["a.ts", 1],
      ["b.ts", 6],
    ]);
    expect(parseCitations(md).length).toBe(5); // other formats are scanned verbatim
  });

  test("render is the inverse of parse", () => {
    const c = { path: "src/a.ts", line: 7, quote: 'x = "y"' };
    const [parsed] = parseCitations(renderCitation(c));
    expect([parsed?.path, parsed?.line, parsed?.quote]).toEqual([c.path, c.line, c.quote]);
  });

  const FILE = ["a", "b", "  if (amount   < 0) throw new Error();", "c", "d", "e"].join("\n");

  test("ok at the cited line, whitespace-insensitive", () => {
    expect(locateQuote(FILE, 3, "if (amount < 0) throw")).toEqual({ status: "ok", line: 3 });
  });

  test("moved within the window: nearest match wins", () => {
    const shifted = `x\nx\nx\n${FILE}`;
    expect(locateQuote(shifted, 3, "if (amount < 0) throw")).toEqual({ status: "moved", line: 6 });
  });

  test("moved far away: a unique match anywhere in the file still resolves", () => {
    const far = `${"filler\n".repeat(50)}${FILE}`;
    expect(locateQuote(far, 3, "if (amount < 0) throw")).toEqual({ status: "moved", line: 53 });
  });

  test("ambiguous far matches or a removed quote are stale", () => {
    const twice = `${"filler\n".repeat(30)}if (amount < 0) throw\n${"filler\n".repeat(30)}if (amount < 0) throw\n`;
    expect(locateQuote(twice, 1, "if (amount < 0) throw").status).toBe("stale");
    expect(locateQuote(FILE, 3, "if (amount <= 0) throw").status).toBe("stale");
    expect(locateQuote(FILE, 3, "   ").status).toBe("stale");
  });

  test("a quote spanning lines starts at its first line", () => {
    const code = "function f() {\n  return compute(\n    a,\n    b);\n}";
    expect(locateQuote(code, 2, "return compute( a,")).toEqual({ status: "ok", line: 2 });
    expect(locateQuote(code, 3, "return compute( a,")).toEqual({ status: "moved", line: 2 });
  });
});

describe("sizes and budgets", () => {
  test("lines ignore the trailing newline; tokens are chars / 4 rounded up", () => {
    expect(sizeOf("a\nb\n")).toEqual({ chars: 4, lines: 2, tokens: 1 });
    expect(sizeOf("")).toEqual({ chars: 0, lines: 0, tokens: 0 });
  });

  test("overBudget names every exceeded dimension", () => {
    expect(overBudget({ chars: 5000, lines: 10, tokens: 1250 }, { chars: 4000, lines: 100 })).toEqual([
      "chars 5000 > 4000",
    ]);
    expect(overBudget({ chars: 1, lines: 1, tokens: 1 }, { tokens: 1 })).toEqual([]);
  });
});

describe("MemoryMap document", () => {
  const base = { kind: "MemoryMap", schemaVersion: 1 };
  const item = {
    id: "t0.agents",
    tier: "T0",
    kind: "canon",
    paths: ["AGENTS.md"],
    load: "always",
    writers: ["human"],
    readers: ["*"],
  };

  test("defaults the knowledge globs and tier budgets", () => {
    const map = MemoryMapDocument.parse({ ...base, items: [item] }, "m.yml")._unsafeUnwrap();
    expect(map.knowledge.include).toContain("**/AGENTS.md");
    expect(map.tierBudgets).toEqual({});
  });

  test.each([
    ["bad load", { ...item, load: "sometimes" }],
    ["bad tier", { ...item, tier: "T9" }],
    ["empty budget", { ...item, budget: {} }],
    ["no readers", { ...item, readers: [] }],
  ])("rejects %s", (_n, bad) => {
    expect(MemoryMapDocument.parse({ ...base, items: [bad] }, "m.yml").isErr()).toBe(true);
  });
});

const MAP = stringify({
  kind: "MemoryMap",
  schemaVersion: 1,
  knowledge: { include: ["AGENTS.md", "docs/**"], exclude: ["docs/drafts/**"] },
  tierBudgets: { T0: { chars: 60 } },
  items: [
    {
      id: "t0.agents",
      tier: "T0",
      kind: "canon",
      paths: ["AGENTS.md"],
      load: "always",
      writers: ["human"],
      readers: ["*"],
      budget: { lines: 3 },
    },
    {
      id: "t1.docs",
      tier: "T1",
      kind: "canon",
      paths: ["docs/**/*.md"],
      load: "explicit",
      writers: ["human"],
      readers: ["*"],
    },
    {
      id: "t1.map",
      tier: "T1",
      kind: "canon",
      paths: ["docs/metator/memory-map.yml"],
      load: "explicit",
      writers: ["human"],
      readers: ["*"],
      citations: false,
    },
    {
      id: "t2.index",
      tier: "T2",
      kind: "derived",
      paths: [".metator/index/**"],
      load: "query:metator graph",
      writers: ["metator"],
      readers: ["*"],
    },
  ],
});

const SRC = "const a = 1;\nexport function pay(amount: number) {\n  if (amount < 0) throw new Error();\n}\n";

function world(files: Record<string, string>) {
  const all: Record<string, string> = {
    "docs/metator/memory-map.yml": MAP,
    "AGENTS.md": "# Agents\nshort\n",
    "src/pay.ts": SRC,
    "docs/guide.md": '# Guide\nPay rejects negatives [[cite: src/pay.ts:3 | "if (amount < 0) throw"]].\n',
    "docs/drafts/wip.md": "ignored draft",
    ".metator/index/imports.json": "{}",
    ...files,
  };
  const fs = new InMemoryFileSystem(all);
  const vcs = new FakeVcs(Object.keys(all).filter((f) => !f.startsWith(".metator/")));
  const reader = new MemoryMapReader(fs, DEFAULT_PATHS);
  const knowledge = new KnowledgeFiles(new SourceFiles(vcs, fs, []));
  const budget = new MemoryBudget(reader, fs);
  const validate = new ValidateCitations(reader, fs);
  return {
    fs,
    inventory: new InventoryMemory(reader, knowledge, fs),
    budget,
    validate,
    check: new CheckMemory(reader, knowledge, fs, budget, validate),
  };
}

const problems = async (files: Record<string, string>) =>
  (await world(files).check.execute())
    ._unsafeUnwrap()
    .problems.map((p) => `${p.severity}: ${p.path ?? p.item ?? ""}: ${p.message}`);

describe("InventoryMemory", () => {
  test("lists knowledge files with item, tier and size; excluded and non-knowledge files are skipped", async () => {
    const inv = (await world({}).inventory.execute())._unsafeUnwrap();
    expect(inv.files.map((f) => [f.path, f.item])).toEqual([
      ["AGENTS.md", "t0.agents"],
      ["docs/guide.md", "t1.docs"],
      ["docs/metator/memory-map.yml", "t1.map"],
    ]);
    expect(inv.totals.T0).toEqual({ chars: 15, lines: 2, tokens: 4, files: 1 });
    expect(inv.unmapped).toEqual([]);
  });

  test("works without a map (audit step 1): default globs, everything unmapped, host front matter kept", async () => {
    const fs = new InMemoryFileSystem({
      "AGENTS.md": "# A",
      ".github/instructions/x.instructions.md": "---\napplyTo: 'src/**'\nfoo: bar\n---\nbody",
      "src/a.ts": "",
    });
    const reader = new MemoryMapReader(fs, DEFAULT_PATHS);
    const inv = new InventoryMemory(
      reader,
      new KnowledgeFiles(new SourceFiles(new FakeVcs("not-a-repo"), fs, [])),
      fs,
    );
    const result = (await inv.execute())._unsafeUnwrap();
    expect(result.mapped).toBe(false);
    expect(result.unmapped).toEqual([".github/instructions/x.instructions.md", "AGENTS.md"]);
    expect(result.files[0]?.frontMatter).toEqual({ applyTo: "src/**" });
  });
});

describe("MemoryBudget", () => {
  test("per-file and per-tier limits, including git-ignored derived files", async () => {
    const w = world({ "AGENTS.md": "1\n2\n3\n4\n".repeat(20) });
    const report = (await w.budget.execute())._unsafeUnwrap();
    expect(report.items.find((i) => i.id === "t0.agents")?.over[0]?.over).toEqual(["lines 80 > 3"]);
    expect(report.items.find((i) => i.id === "t2.index")?.files).toBe(1);
    expect(report.tiers.find((t) => t.tier === "T0")?.over).toEqual(["chars 160 > 60"]);
    expect(report.overBudget).toBe(2);
  });

  test("no map is NOT_FOUND with a hint", async () => {
    const fs = new InMemoryFileSystem({});
    const error = (
      await new MemoryBudget(new MemoryMapReader(fs, DEFAULT_PATHS), fs).execute()
    )._unsafeUnwrapErr();
    expect([error.code, error.hint?.includes("memory inventory")]).toEqual(["NOT_FOUND", true]);
  });
});

describe("ValidateCitations", () => {
  test("a true citation is ok", async () => {
    const report = (await world({}).validate.execute({ fix: false }))._unsafeUnwrap();
    expect(report.citations).toEqual([
      { file: "docs/guide.md", at: 2, cites: "src/pay.ts:3", status: "ok", line: 3 },
    ]);
  });

  test("moved code: reported, then fixed in place with --fix", async () => {
    const w = world({ "src/pay.ts": `// header\n// header\n${SRC}` });
    expect((await w.validate.execute({ fix: false }))._unsafeUnwrap().counts.moved).toBe(1);
    expect((await w.validate.execute({ fix: true }))._unsafeUnwrap().counts.fixed).toBe(1);
    expect((await w.fs.read("docs/guide.md"))._unsafeUnwrap()).toContain(
      '[[cite: src/pay.ts:5 | "if (amount < 0) throw"]]',
    );
    expect((await w.validate.execute({ fix: false }))._unsafeUnwrap().counts.ok).toBe(1);
  });

  test("removed code is stale and a deleted file is missing-file; neither is ever auto-fixed", async () => {
    const w = world({
      "src/pay.ts": "export function pay() {}\n",
      "docs/other.md": '[[cite: src/gone.ts:1 | "x"]]',
    });
    const report = (await w.validate.execute({ fix: true }))._unsafeUnwrap();
    expect(report.citations.map((c) => [c.file, c.status])).toEqual([
      ["docs/guide.md", "stale"],
      ["docs/other.md", "missing-file"],
    ]);
  });

  test("items with citations disabled are not scanned", async () => {
    const report = (await world({}).validate.execute({ fix: false }))._unsafeUnwrap();
    // AGENTS.md, guide.md and the draft (excluded from knowledge, but still a docs/**/*.md file); not the map.
    expect(report.files).toBe(3);
  });
});

describe("CheckMemory", () => {
  test("a healthy map passes", async () => {
    expect(await problems({})).toEqual([]);
  });

  test("unmapped knowledge, budgets, stale and moved citations, dead items", async () => {
    const result = await problems({
      "AGENTS.md": "1\n2\n3\n4\n",
      "src/pay.ts": `// moved\n${SRC}`,
      "docs/metator/memory-map.yml": MAP.replace(".metator/index/**", ".metator/nothing/**").replace(
        "knowledge:\n  include:\n    - AGENTS.md",
        "knowledge:\n  include:\n    - AGENTS.md\n    - notes/**",
      ),
      "notes/todo.md": "untracked knowledge",
    });
    expect(result).toEqual([
      "warning: t2.index: paths match no file: .metator/nothing/**",
      "error: notes/todo.md: knowledge file is not covered by any memory map item",
      "error: AGENTS.md: over budget: lines 4 > 3",
      "warning: docs/guide.md: line 2: citation src/pay.ts:3 moved to line 4; run `metator memory validate --fix`",
    ]);
  });
});
