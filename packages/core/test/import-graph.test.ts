import { describe, expect, test } from "bun:test";
import { FakeVcs, InMemoryFileSystem } from "@metator/testing";
import { BuildImportGraph, GraphQueries } from "../src/application/import-graph.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { SourceFiles } from "../src/application/source-files.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { classifyEdge, packageOf } from "../src/domain/import-index.ts";
import { err, ok } from "../src/domain/result.ts";
import type { ImportAnalyzer, ImportSpecifier, Resolution, WorkspaceReader } from "../src/ports/index.ts";

/** Analyzer fake: `// import ./x` lines are imports; resolution by a lookup table. */
class FakeAnalyzer implements ImportAnalyzer {
  readonly extensions = [".ts"];
  parses = 0;
  constructor(private readonly table: Record<string, Resolution>) {}
  fingerprint(content: string): string {
    return String(content.length) + content.slice(0, 20);
  }
  parse(path: string, content: string) {
    this.parses++;
    if (content.includes("SYNTAX ERROR")) return err(new MetatorError("PARSE_FAILED", `${path}: boom`));
    const imports: ImportSpecifier[] = [...content.matchAll(/\/\/ import (\S+)/g)].map((m) => ({
      specifier: m[1] as string,
      kind: "static",
      typeOnly: false,
    }));
    return ok(imports);
  }
  resolve(from: string, specifier: string): Resolution {
    return this.table[`${from}->${specifier}`] ?? { type: "unresolved" };
  }
}

const workspace: WorkspaceReader = {
  packages: async () =>
    ok([
      { name: "@a/core", dir: "packages/core" },
      { name: "@a/app", dir: "apps/app" },
    ]),
};

function world(files: Record<string, string>, table: Record<string, Resolution>) {
  const fs = new InMemoryFileSystem(files);
  const analyzer = new FakeAnalyzer(table);
  const sources = new SourceFiles(new FakeVcs(Object.keys(files)), fs, ["**/dist/**"]);
  const build = new BuildImportGraph(sources, fs, analyzer, workspace, DEFAULT_PATHS, "fake@1");
  return { fs, analyzer, build, queries: new GraphQueries(build) };
}

const FILES = {
  "packages/core/src/a.ts": "// import ./b\n// import lodash",
  "packages/core/src/b.ts": "export const b = 1;",
  "apps/app/src/main.ts": "// import @a/core\n// import ./missing",
  "dist/out.ts": "// import ../packages/core/src/a.ts",
  "README.md": "not source",
};
const TABLE: Record<string, Resolution> = {
  "packages/core/src/a.ts->./b": { type: "file", path: "packages/core/src/b.ts" },
  "packages/core/src/a.ts->lodash": { type: "external", name: "lodash" },
  "apps/app/src/main.ts->@a/core": { type: "file", path: "packages/core/src/a.ts" },
};

describe("BuildImportGraph", () => {
  test("edges are classified, externals and unresolved imports reported, ignored files skipped", async () => {
    const report = (await world(FILES, TABLE).build.execute())._unsafeUnwrap();
    expect(report.files).toEqual([
      "apps/app/src/main.ts",
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
    ]);
    expect(report.edges).toEqual([
      { from: "packages/core/src/a.ts", to: "packages/core/src/b.ts", kind: "internal" },
      { from: "apps/app/src/main.ts", to: "packages/core/src/a.ts", kind: "cross-package" },
    ]);
    expect(report.externals).toEqual(["lodash"]);
    expect(report.unresolved).toEqual([{ from: "apps/app/src/main.ts", specifier: "./missing" }]);
  });

  test("second build reuses cached parses; only changed files are parsed again", async () => {
    const w = world(FILES, TABLE);
    expect((await w.build.execute())._unsafeUnwrap().stats).toEqual({ parsed: 3, reused: 0, failed: 0 });
    await w.fs.write("packages/core/src/b.ts", "export const b = 2; // changed");
    expect((await w.build.execute())._unsafeUnwrap().stats).toEqual({ parsed: 1, reused: 2, failed: 0 });
  });

  test("the cache is a versioned ImportIndex document", async () => {
    const w = world(FILES, TABLE);
    await w.build.execute();
    const index = JSON.parse((await w.fs.read(".metator/index/imports.json"))._unsafeUnwrap());
    expect([index.kind, index.schemaVersion, index.analyzer]).toEqual(["ImportIndex", 1, "fake@1"]);
  });

  test("a corrupted or foreign cache is ignored and rebuilt, never fatal", async () => {
    const w = world(FILES, TABLE);
    await w.fs.write(".metator/index/imports.json", "{ not json");
    expect((await w.build.execute())._unsafeUnwrap().stats.parsed).toBe(3);
    await w.fs.write(
      ".metator/index/imports.json",
      JSON.stringify({ kind: "ImportIndex", schemaVersion: 1, analyzer: "other@9", files: {} }),
    );
    expect((await w.build.execute())._unsafeUnwrap().stats.parsed).toBe(3);
  });

  test("resolution is redone even for cached files (a new file can satisfy an old import)", async () => {
    const w = world(FILES, TABLE);
    await w.build.execute();
    const table = TABLE as Record<string, Resolution>;
    table["apps/app/src/main.ts->./missing"] = { type: "file", path: "apps/app/src/missing.ts" };
    try {
      const report = (await w.build.execute())._unsafeUnwrap();
      expect(report.unresolved).toEqual([]);
      expect(report.stats.parsed).toBe(0);
    } finally {
      delete table["apps/app/src/main.ts->./missing"];
    }
  });

  test("the same unresolved import used twice in a file is reported once", async () => {
    const files = { "a.ts": "// import ./gone\n// import ./gone" };
    const report = (await world(files, {}).build.execute())._unsafeUnwrap();
    expect(report.unresolved).toEqual([{ from: "a.ts", specifier: "./gone" }]);
  });

  test("files that fail to parse are reported and skipped, the rest of the graph still builds", async () => {
    const report = (
      await world({ ...FILES, "packages/core/src/bad.ts": "SYNTAX ERROR" }, TABLE).build.execute()
    )._unsafeUnwrap();
    expect(report.stats.failed).toBe(1);
    expect(report.parseErrors[0]?.file).toBe("packages/core/src/bad.ts");
    expect(report.edges).toHaveLength(2);
  });

  test("outside git, source files come from the file system", async () => {
    const fs = new InMemoryFileSystem({ "src/a.ts": "// import ./b", "src/b.ts": "" });
    const analyzer = new FakeAnalyzer({ "src/a.ts->./b": { type: "file", path: "src/b.ts" } });
    const sources = new SourceFiles(new FakeVcs("not-a-repo"), fs, []);
    const build = new BuildImportGraph(
      sources,
      fs,
      analyzer,
      { packages: async () => ok([]) },
      DEFAULT_PATHS,
      "f",
    );
    expect((await build.execute())._unsafeUnwrap().edges).toEqual([
      { from: "src/a.ts", to: "src/b.ts", kind: "internal" },
    ]);
  });
});

describe("GraphQueries", () => {
  const q = () => world(FILES, TABLE).queries;

  test("direct and transitive dependencies", async () => {
    expect((await q().dependencies("apps/app/src/main.ts", false))._unsafeUnwrap()).toEqual([
      "packages/core/src/a.ts",
    ]);
    expect((await q().dependencies("apps/app/src/main.ts", true))._unsafeUnwrap()).toEqual([
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
    ]);
  });

  test("direct and transitive dependents", async () => {
    expect((await q().dependents("packages/core/src/b.ts", false))._unsafeUnwrap()).toEqual([
      "packages/core/src/a.ts",
    ]);
    expect((await q().dependents("packages/core/src/b.ts", true))._unsafeUnwrap()).toEqual([
      "apps/app/src/main.ts",
      "packages/core/src/a.ts",
    ]);
  });

  test("path between files, null when there is none", async () => {
    expect((await q().path("apps/app/src/main.ts", "packages/core/src/b.ts"))._unsafeUnwrap()).toEqual([
      "apps/app/src/main.ts",
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
    ]);
    expect((await q().path("packages/core/src/b.ts", "apps/app/src/main.ts"))._unsafeUnwrap()).toBeNull();
  });

  test("a path keeps import order, it is not sorted", async () => {
    const files = { "z.ts": "// import ./a", "a.ts": "// import ./m", "m.ts": "" };
    const table: Record<string, Resolution> = {
      "z.ts->./a": { type: "file", path: "a.ts" },
      "a.ts->./m": { type: "file", path: "m.ts" },
    };
    expect((await world(files, table).queries.path("z.ts", "m.ts"))._unsafeUnwrap()).toEqual([
      "z.ts",
      "a.ts",
      "m.ts",
    ]);
  });

  test("unknown file is NOT_FOUND with a hint", async () => {
    const error = (await q().dependencies("nope.ts", false))._unsafeUnwrapErr();
    expect([error.code, error.hint?.includes("repo-relative")]).toEqual(["NOT_FOUND", true]);
  });

  test("cross-package edges are aggregated per package pair", async () => {
    expect((await q().packageEdges())._unsafeUnwrap()).toEqual([{ from: "@a/app", to: "@a/core", count: 1 }]);
  });
});

describe("packageOf / classifyEdge", () => {
  const pkgs = [
    { name: "root", dir: "." },
    { name: "@a/core", dir: "packages/core" },
    { name: "@a/core-ui", dir: "packages/core-ui" },
    { name: "@a/nested", dir: "packages/core/nested" },
  ];

  test("deepest directory wins; prefix must end at a path separator", () => {
    expect(packageOf("packages/core/src/a.ts", pkgs)?.name).toBe("@a/core");
    expect(packageOf("packages/core-ui/src/a.ts", pkgs)?.name).toBe("@a/core-ui");
    expect(packageOf("packages/core/nested/x.ts", pkgs)?.name).toBe("@a/nested");
    expect(packageOf("scripts/x.ts", pkgs)?.name).toBe("root");
    expect(packageOf("scripts/x.ts", pkgs.slice(1))).toBeUndefined();
  });

  test("same package is internal, different package is cross-package", () => {
    expect(classifyEdge("packages/core/a.ts", "packages/core/b.ts", pkgs)).toBe("internal");
    expect(classifyEdge("packages/core/a.ts", "packages/core-ui/b.ts", pkgs)).toBe("cross-package");
    const workspaces = pkgs.slice(1);
    expect(classifyEdge("e2e/a.ts", "e2e/helpers/b.ts", workspaces)).toBe("internal");
    expect(classifyEdge("e2e/a.ts", "packages/core/b.ts", workspaces)).toBe("cross-package");
  });
});
