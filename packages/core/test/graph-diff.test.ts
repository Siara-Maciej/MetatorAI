import { describe, expect, test } from "bun:test";
import { FakeVcs } from "@metator/testing";
import { DiffImportGraph } from "../src/application/graph-diff.ts";
import { MetatorError } from "../src/domain/errors.ts";
import type { Edge } from "../src/domain/graph.ts";
import { diffGraphs } from "../src/domain/graph-diff.ts";
import { err, ok } from "../src/domain/result.ts";
import type { ImportAnalyzer, RevisionReader } from "../src/ports/index.ts";

const PACKAGES = [
  { name: "@acme/core", dir: "packages/core" },
  { name: "@acme/web", dir: "packages/web" },
  { name: "@acme/ui", dir: "packages/ui" },
];
const e = (from: string, to: string, kind: Edge["kind"] = "internal"): Edge => ({ from, to, kind });
const CORE = "packages/core/src";
const WEB = "packages/web/src";

describe("diffGraphs", () => {
  test("added and removed edges, sorted; external edges are ignored", () => {
    const base = [e(`${CORE}/a.ts`, `${CORE}/b.ts`), e(`${CORE}/a.ts`, "zod", "external")];
    const current = [e(`${CORE}/a.ts`, `${CORE}/c.ts`), e(`${CORE}/a.ts`, `${CORE}/b2.ts`)];
    expect(diffGraphs(base, current, PACKAGES)).toEqual({
      added: [e(`${CORE}/a.ts`, `${CORE}/b2.ts`), e(`${CORE}/a.ts`, `${CORE}/c.ts`)],
      removed: [e(`${CORE}/a.ts`, `${CORE}/b.ts`)],
      newPackageDependencies: [],
      newCycles: [],
    });
  });

  test("a package that starts depending on another package is named once, with one edge as evidence", () => {
    const base = [e(`${WEB}/app.ts`, "packages/ui/src/button.ts", "cross-package")];
    const current = [
      ...base,
      e(`${WEB}/page.ts`, "packages/ui/src/card.ts", "cross-package"),
      e(`${WEB}/app.ts`, `${CORE}/money.ts`, "cross-package"),
      e(`${WEB}/page.ts`, `${CORE}/tax.ts`, "cross-package"),
    ];
    expect(diffGraphs(base, current, PACKAGES).newPackageDependencies).toEqual([
      { from: "@acme/web", to: "@acme/core", via: `${WEB}/app.ts → ${CORE}/money.ts` },
    ]);
  });

  test("only cycles closed by an added edge are new", () => {
    const old = [e("x.ts", "y.ts"), e("y.ts", "x.ts")];
    const base = [...old, e(`${CORE}/a.ts`, `${CORE}/b.ts`)];
    const current = [...base, e(`${CORE}/b.ts`, `${CORE}/a.ts`)];
    expect(diffGraphs(base, current, PACKAGES).newCycles).toEqual([[`${CORE}/a.ts`, `${CORE}/b.ts`]]);
    expect(diffGraphs(base, base, PACKAGES).newCycles).toEqual([]);
    // An edge added inside a cycle that already existed does not make a new one.
    const ring = [e("a.ts", "b.ts"), e("b.ts", "c.ts"), e("c.ts", "a.ts")];
    expect(diffGraphs(ring, [...ring, e("a.ts", "c.ts")], PACKAGES).newCycles).toEqual([]);
  });
});

/** Imports are lines `import "<target>"`; resolution maps "./x" next to the importer. */
const analyzer: ImportAnalyzer = {
  extensions: [".ts"],
  fingerprint: (c) => c,
  parse: (_path, content) =>
    content === "!"
      ? err(new MetatorError("INVALID_ARTIFACT", "cannot parse"))
      : ok(
          [...content.matchAll(/import "([^"]+)"/g)].map((m) => ({
            specifier: m[1] as string,
            kind: "static" as const,
            typeOnly: false,
          })),
        ),
  resolve: (from, specifier) =>
    specifier.startsWith("./")
      ? { type: "file", path: `${from.slice(0, from.lastIndexOf("/"))}/${specifier.slice(2)}.ts` }
      : { type: "external", name: specifier },
};
const history = (files: Record<string, string>): RevisionReader => ({
  readAt: async (_b, p) => ok(files[p]),
  addedLines: async () => ok(new Map()),
});
const graph = (edges: Edge[]) => ({
  execute: async () =>
    ok({
      files: [],
      edges,
      packages: PACKAGES,
      externals: [],
      externalUses: [],
      unresolved: [],
      stats: { parsed: 0, reused: 0, failed: 0 },
      parseErrors: [],
    }),
});

describe("DiffImportGraph", () => {
  test("changed files get their base edges from the merge base; unchanged files keep theirs", async () => {
    const current = [
      e(`${CORE}/a.ts`, `${CORE}/c.ts`),
      e(`${CORE}/u.ts`, `${CORE}/a.ts`),
      e(`${CORE}/n.ts`, `${CORE}/a.ts`),
    ];
    const diff = new DiffImportGraph(
      new FakeVcs([], [`${CORE}/a.ts`, `${CORE}/n.ts`, `${CORE}/gone.ts`, "README.md"]),
      history({ [`${CORE}/a.ts`]: 'import "./b";\nimport "zod";', [`${CORE}/gone.ts`]: 'import "./a";' }),
      graph(current),
      analyzer,
    );
    expect((await diff.execute({ base: "main" }))._unsafeUnwrap()).toEqual({
      base: "main",
      changed: 4,
      added: [e(`${CORE}/a.ts`, `${CORE}/c.ts`), e(`${CORE}/n.ts`, `${CORE}/a.ts`)],
      removed: [e(`${CORE}/a.ts`, `${CORE}/b.ts`), e(`${CORE}/gone.ts`, `${CORE}/a.ts`)],
      newPackageDependencies: [],
      newCycles: [],
    });
  });

  test("an unparsable base version contributes no edges; failures are error values", async () => {
    const files = [`${CORE}/a.ts`];
    const unparsable = new DiffImportGraph(
      new FakeVcs([], files),
      history({ [`${CORE}/a.ts`]: "!" }),
      graph([]),
      analyzer,
    );
    expect((await unparsable.execute({ base: "main" }))._unsafeUnwrap().removed).toEqual([]);
    const failing: RevisionReader = {
      readAt: async () => err(MetatorError.usage("Unknown base ref")),
      addedLines: async () => ok(new Map()),
    };
    const viaHistory = new DiffImportGraph(new FakeVcs([], files), failing, graph([]), analyzer);
    expect((await viaHistory.execute({ base: "x" }))._unsafeUnwrapErr().code).toBe("USAGE");
    const notRepo = new DiffImportGraph(new FakeVcs("not-a-repo"), history({}), graph([]), analyzer);
    expect((await notRepo.execute({ base: "x" }))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});
