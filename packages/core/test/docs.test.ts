import { describe, expect, test } from "bun:test";
import { FakeVcs, FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DocsDrift, DocsInventory, DocsLinks } from "../src/application/docs.ts";
import { FindOwners } from "../src/application/owners.ts";
import { SourceFiles } from "../src/application/source-files.ts";
import { ClaimSetDocument, markdownLinks, resolveLink } from "../src/domain/docs.ts";
import { ok } from "../src/domain/result.ts";
import { serializeJsonDocument } from "../src/domain/versioned.ts";

describe("markdownLinks", () => {
  test("inline links, images and definitions with their line; code is not scanned", () => {
    const md = [
      'See [the guide](guide.md#setup "Setup") and ![logo](<img/logo.svg>).',
      "`[not](a-link.md)` and",
      "```",
      "[also not](x.md)",
      "```",
      "[ref]: ../other.md",
      "[escaped \\] bracket](a.md)",
    ].join("\n");
    expect(markdownLinks(md)).toEqual([
      { target: "guide.md#setup", line: 1 },
      { target: "img/logo.svg", line: 1 },
      { target: "../other.md", line: 6 },
      { target: "a.md", line: 7 },
    ]);
  });
});

describe("resolveLink", () => {
  test("relative to the document, to the root with a leading slash, external schemes skipped", () => {
    expect(resolveLink("docs/design/a.md", "../adr/0001.md#context")).toEqual({
      type: "file",
      path: "docs/adr/0001.md",
      anchor: "context",
    });
    expect(resolveLink("docs/a.md", "/README.md")).toEqual({ type: "file", path: "README.md" });
    expect(resolveLink("docs/a.md", "#local")).toEqual({ type: "file", path: "docs/a.md", anchor: "local" });
    expect(resolveLink("docs/a.md", "./My%20File.md?raw=1#")).toEqual({
      type: "file",
      path: "docs/My File.md",
    });
    expect(resolveLink("docs/a.md", "bad%zz.md")).toEqual({ type: "file", path: "docs/bad%zz.md" });
    for (const t of ["https://x.dev", "mailto:a@b.c", "//cdn.x/y.js"])
      expect(resolveLink("a.md", t)).toEqual({ type: "external" });
  });
});

const DOCS = {
  "README.md":
    "# Title\n\n[guide](docs/guide.md#install) [dir](docs) [gone](docs/gone.md) [web](https://x.dev)",
  "docs/guide.md": "# Guide\n\n## Install\n\n[back](../README.md#title) [bad](#nope) [code](../src/a.ts#L3)",
  "src/a.ts": "export const a = 1;\n",
};
const linksOf = (files: Record<string, string>) => {
  const fs = new InMemoryFileSystem(files);
  const sources = new SourceFiles(new FakeVcs(Object.keys(files)), fs, []);
  return { fs, sources, links: new DocsLinks(sources, fs) };
};

describe("DocsLinks", () => {
  test("missing files and missing headings are dead; directories and code line anchors are fine", async () => {
    expect((await linksOf(DOCS).links.execute())._unsafeUnwrap()).toEqual({
      documents: 2,
      links: 6,
      dead: [
        { file: "README.md", line: 3, target: "docs/gone.md", reason: "missing-file" },
        { file: "docs/guide.md", line: 5, target: "#nope", reason: "missing-anchor" },
      ],
    });
  });

  test("outside git, documents come from the file system", async () => {
    const fs = new InMemoryFileSystem({ "a.md": "[b](b.md)", "b.md": "# B" });
    const r = await new DocsLinks(new SourceFiles(new FakeVcs("not-a-repo"), fs, []), fs).execute();
    expect(r._unsafeUnwrap()).toEqual({ documents: 2, links: 1, dead: [] });
  });
});

describe("DocsInventory", () => {
  test("every document with lines, last change, age, owners and its links", async () => {
    const w = linksOf({ ...DOCS, ".github/CODEOWNERS": "*.md @docs\n" });
    const revisions = {
      lastChanged: async () =>
        ok(new Map([["README.md", "2026-10-01T00:00:00Z"]]) as ReadonlyMap<string, string>),
    };
    const inventory = new DocsInventory(
      w.sources,
      w.fs,
      revisions,
      new FindOwners(w.fs),
      w.links,
      new FixedClock(new Date("2026-10-26T12:00:00Z")),
    );
    expect((await inventory.execute())._unsafeUnwrap()).toEqual({
      codeowners: ".github/CODEOWNERS",
      documents: [
        {
          path: "README.md",
          lines: 3,
          lastChanged: "2026-10-01T00:00:00Z",
          ageDays: 25,
          owners: ["@docs"],
          links: 3,
          deadLinks: 1,
        },
        { path: "docs/guide.md", lines: 5, owners: ["@docs"], links: 3, deadLinks: 1 },
      ],
    });
  });
});

const CODE = "line 1\nexport const TAX = 0.23;\nline 3\n";
const claims = (list: object[]) => serializeJsonDocument(ClaimSetDocument.stamp({ claims: list as never }));
const claim = (id: string, line: number, quote: string, extra: object = {}) => ({
  id,
  source: "docs/a.md",
  statement: "s",
  status: "verified",
  evidence: { path: "src/tax.ts", line, quote },
  ...extra,
});

describe("DocsDrift", () => {
  test("ok, moved and stale claims; unverified claims are not checked", async () => {
    const fs = new InMemoryFileSystem({
      "src/tax.ts": CODE,
      "c.json": claims([
        claim("a", 2, "export const TAX"),
        claim("b", 5, "export const TAX"),
        claim("c", 2, "export const VAT"),
        claim("d", 2, "x", { evidence: { path: "src/gone.ts", line: 1, quote: "x" } }),
        { id: "e", source: "docs/a.md", statement: "s", status: "no-evidence" },
        // Already reported as drift: its old evidence is not checked again.
        claim("f", 2, "export const VAT", { status: "drift" }),
      ]),
    });
    const r = (await new DocsDrift(fs, "c.json").execute({ fix: false }))._unsafeUnwrap();
    expect(r.checked).toBe(4);
    expect(r.results.map((x) => [x.id, x.status, x.line])).toEqual([
      ["a", "ok", 2],
      ["b", "moved", 2],
      ["c", "stale", undefined],
      ["d", "missing-file", undefined],
    ]);
  });

  test("--fix rewrites only the lines of moved claims", async () => {
    const fs = new InMemoryFileSystem({
      "src/tax.ts": CODE,
      "c.json": claims([claim("b", 5, "export const TAX")]),
    });
    await new DocsDrift(fs, "c.json").execute({ fix: true });
    const raw = JSON.parse((await fs.read("c.json"))._unsafeUnwrap());
    expect(ClaimSetDocument.parse(raw, "c.json")._unsafeUnwrap().claims[0]?.evidence?.line).toBe(2);
    const untouched = new InMemoryFileSystem({
      "src/tax.ts": CODE,
      "c.json": claims([claim("a", 2, "export const TAX")]),
    });
    const before = (await untouched.read("c.json"))._unsafeUnwrap();
    await new DocsDrift(untouched, "c.json").execute({ fix: true });
    expect((await untouched.read("c.json"))._unsafeUnwrap()).toBe(before);
  });

  test("no claims file means nothing to check; an invalid one is an error value", async () => {
    expect(
      (await new DocsDrift(new InMemoryFileSystem({}), "c.json").execute({ fix: false }))._unsafeUnwrap(),
    ).toEqual({ file: "c.json", checked: 0, results: [] });
    const bad = new InMemoryFileSystem({
      "c.json": claims([{ id: "a", source: "x", statement: "s", status: "verified" }]),
    });
    const e = (await new DocsDrift(bad, "c.json").execute({ fix: false }))._unsafeUnwrapErr();
    expect(e.message).toContain('Claim "a" is verified without evidence');
    const dup = new InMemoryFileSystem({ "c.json": claims([claim("a", 1, "q"), claim("a", 1, "q")]) });
    expect((await new DocsDrift(dup, "c.json").execute({ fix: false }))._unsafeUnwrapErr().message).toContain(
      'Duplicate claim "a"',
    );
  });
});
