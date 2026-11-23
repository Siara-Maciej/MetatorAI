import { describe, expect, test } from "bun:test";
import { FakeVcs, FixedClock, InMemoryFileSystem } from "@metator/testing";
import {
  AnalyzerByExtension,
  analyzersId,
  DEFAULT_PATHS,
  err,
  type ImportAnalyzer,
  type JavaBuild,
  type JavaParsedFile,
  type JavaSourceParser,
  MergedWorkspace,
  MetatorError,
  NO_DESCRIPTOR_FACTS,
  ok,
  ReadJava,
  type Result,
  SourceFiles,
} from "../src/index.ts";
import { file, module, repo, type } from "./fixtures/java.ts";

/** A parser that reads `class <Name>` lines, `package x;` and `BROKEN`; counts what it parses. */
class CountingParser implements JavaSourceParser {
  readonly id = "fake/1";
  parsed: string[] = [];
  async parse(path: string, content: string): Promise<Result<JavaParsedFile, MetatorError>> {
    this.parsed.push(path);
    if (content.includes("CRASH")) return err(new MetatorError("BIN_NOT_FOUND", "no grammar"));
    const pkg = /package ([\w.]+);/.exec(content)?.[1] ?? "";
    const types = [...content.matchAll(/class (\w+)/g)].map((m) => type(`${pkg ? `${pkg}.` : ""}${m[1]}`));
    return ok({
      package: pkg,
      imports: [],
      types,
      references: [],
      calls: [],
      ...(content.includes("BROKEN") ? { error: { message: "syntax error", line: 2 } } : {}),
    });
  }
}

const hasher = { sha256: (t: string) => `h${t.length}:${t}` };
const build: JavaBuild = {
  tools: ["maven"],
  modules: [
    module("a", {
      dir: "a",
      sourceRoots: [
        { path: "a/src/main/java", kind: "main", declared: false },
        { path: "a/target/generated-sources/x", kind: "generated", declared: false },
      ],
    }),
    module("b", { dir: "b", sourceRoots: [{ path: "b/src/test/java", kind: "test", declared: false }] }),
  ],
  notes: [],
};

function world(files: Record<string, string>) {
  const fs = new InMemoryFileSystem(files);
  const parser = new CountingParser();
  const make = () =>
    new ReadJava(
      new SourceFiles(new FakeVcs("not-a-repo"), fs, ["**/target/**", "**/build/**"]),
      fs,
      { read: async () => ok(build) },
      parser,
      {
        parse: (path, text) =>
          text.includes("<bad")
            ? err(new MetatorError("PARSE_FAILED", `${path}: bad`))
            : ok({ ...NO_DESCRIPTOR_FACTS, config: [{ key: "k", value: text, line: 1 }] }),
      },
      hasher,
      new FixedClock(),
      DEFAULT_PATHS,
    );
  return { fs, parser, make };
}

describe("ReadJava", () => {
  test("files are placed (module, test, generated); generated roots are read even when ignored", async () => {
    const w = world({
      "a/src/main/java/p/A.java": "package p; class A",
      "a/target/generated-sources/x/p/G.java": "package p; class G",
      "b/src/test/java/q/T.java": "package q; class T",
      // A package named like a build output is still source.
      "a/src/main/java/p/build/B.java": "package p.build; class B",
    });
    const types = (await w.make().types({}))._unsafeUnwrap().types;
    expect(types.map((t) => [t.name, t.module, t.test, t.generated])).toEqual([
      ["p.A", "a", false, false],
      ["p.build.B", "a", false, false],
      ["p.G", "a", false, true],
      ["q.T", "b", true, false],
    ]);
  });

  test("the cache: unchanged files are reused, a changed file is parsed again, a removed one leaves", async () => {
    const w = world({
      "a/src/main/java/p/A.java": "package p; class A",
      "a/src/main/java/p/B.java": "package p; class B",
    });
    expect((await w.make().index())._unsafeUnwrap()).toMatchObject({
      files: 2,
      parsed: 2,
      reused: 0,
      current: true,
      path: ".metator/index/java.json",
    });
    const written = (await w.fs.read(".metator/index/java.json"))._unsafeUnwrap();
    expect(written).toContain('"kind":"JavaIndex"');
    expect((await w.make().index())._unsafeUnwrap()).toMatchObject({ parsed: 0, reused: 2 });
    await w.fs.write("a/src/main/java/p/B.java", "package p; class B2");
    expect((await w.make().index({ check: true }))._unsafeUnwrapErr()).toMatchObject({
      code: "STALE_INDEX",
      details: { stale: ["a/src/main/java/p/B.java"] },
    });
    w.parser.parsed = [];
    expect((await w.make().index())._unsafeUnwrap()).toMatchObject({ parsed: 1, reused: 1 });
    expect(w.parser.parsed).toEqual(["a/src/main/java/p/B.java"]);
    expect((await w.make().index({ check: true }))._unsafeUnwrap().current).toBe(true);
    await w.fs.remove("a/src/main/java/p/A.java");
    expect((await w.make().index({ check: true }))._unsafeUnwrapErr().details).toMatchObject({
      stale: ["a/src/main/java/p/A.java"],
    });
    await w.make().index();
    expect((await w.fs.read(".metator/index/java.json"))._unsafeUnwrap()).not.toContain("p/A.java");
  });

  test("an index written by another parser is ignored and rebuilt", async () => {
    const w = world({ "a/src/main/java/p/A.java": "package p; class A" });
    await w.make().index();
    const text = (await w.fs.read(".metator/index/java.json"))._unsafeUnwrap();
    await w.fs.write(".metator/index/java.json", text.replace('"fake/1"', '"other/9"'));
    expect((await w.make().index())._unsafeUnwrap().parsed).toBe(1);
  });

  test("a file with a syntax error and a descriptor that does not parse are reported; the rest is read", async () => {
    const w = world({
      "a/src/main/java/p/A.java": "package p; class A",
      "a/src/main/java/p/Bad.java": "package p; class Bad BROKEN",
      "a/src/main/resources/application.yml": "ok",
      "a/src/main/resources/applicationContext.xml": "<bad",
    });
    const o = (await w.make().overview())._unsafeUnwrap();
    expect(o.parseFailures).toEqual([
      { file: "a/src/main/java/p/Bad.java", message: "syntax error", line: 2 },
      {
        file: "a/src/main/resources/applicationContext.xml",
        message: "a/src/main/resources/applicationContext.xml: bad",
      },
    ]);
    expect(o.counts).toMatchObject({ files: 2, types: 2, configKeys: 1 });
    expect(o.buildTools).toEqual(["maven"]);
  });

  test("a parser that cannot run fails the command with its error", async () => {
    const w = world({ "a/src/main/java/p/A.java": "CRASH" });
    expect((await w.make().overview())._unsafeUnwrapErr().code).toBe("BIN_NOT_FOUND");
  });

  test("show: a qualified name, a unique simple name; AMBIGUOUS with candidates; NOT_FOUND", async () => {
    const w = world({
      "a/src/main/java/p/A.java": "package p; class A",
      "a/src/main/java/p/Dup.java": "package p; class Dup",
      "a/src/main/java/q/Dup.java": "package q; class Dup",
    });
    const reader = w.make();
    expect((await reader.show("A"))._unsafeUnwrap().type.qualifiedName).toBe("p.A");
    expect((await reader.show("q.Dup"))._unsafeUnwrap().type.at).toBe("a/src/main/java/q/Dup.java:1");
    expect((await reader.show("Dup"))._unsafeUnwrapErr()).toMatchObject({
      code: "AMBIGUOUS",
      details: { candidates: ["p.Dup", "q.Dup"] },
    });
    expect((await reader.show("Nope"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("filters: --module and --package", async () => {
    const w = world({
      "a/src/main/java/p/x/A.java": "package p.x; class A",
      "a/src/main/java/px/B.java": "package px; class B",
      "b/src/test/java/p/C.java": "package p; class C",
    });
    const names = async (f: { module?: string; package?: string }) =>
      (await w.make().types(f))._unsafeUnwrap().types.map((t) => t.name);
    expect(await names({ package: "p" })).toEqual(["p.C", "p.x.A"]);
    expect(await names({ module: "a" })).toEqual(["p.x.A", "px.B"]);
  });
});

describe("JavaRepository", () => {
  test("supertypes, subtypes and the files that use a type", () => {
    const r = repo([
      file("m", [type("p.Base")]),
      file("m", [type("p.Mid", { extends: ["Base"] })]),
      file("m", [type("p.Leaf", { extends: ["Mid"], implements: ["Comparable<Leaf>"] })], {
        references: ["Mid"],
      }),
      file("m", [type("q.User")], {
        imports: [{ name: "p.Mid", static: false, onDemand: false, line: 1 }],
        references: ["Mid"],
      }),
    ]);
    expect(r.supertypes("p.Leaf")).toEqual(["p.Mid", "p.Base", "Comparable"]);
    expect(r.subtypes("p.Base")).toEqual(["p.Leaf", "p.Mid"]);
    expect(r.usersOf("p.Mid")).toEqual(["m/src/main/java/p/Leaf.java", "m/src/main/java/q/User.java"]);
  });
});

describe("several languages behind one analyzer", () => {
  const fake = (ext: string, tag: string): ImportAnalyzer & { symbols: () => never } => ({
    extensions: [ext],
    fingerprint: (c) => `${tag}:${c}`,
    parse: (path) => ok([{ specifier: `${tag}:${path}`, kind: "static", typeOnly: false }]),
    resolve: (_f, s) => ({ type: "external", name: `${tag}:${s}` }),
    notes: () => [`${tag} note`],
    symbols: () => {
      throw new Error("not used");
    },
  });

  test("each file goes to its extension's analyzer; resolution follows the importing file", () => {
    const a = new AnalyzerByExtension([{ imports: fake(".ts", "ts") }, { imports: fake(".java", "java") }]);
    expect(a.extensions).toEqual([".ts", ".java"]);
    expect(a.fingerprint("x", "A.java")).toBe("java:x");
    expect(a.fingerprint("x", "a.ts")).toBe("ts:x");
    expect(a.fingerprint("x")).toBe("ts:x");
    expect(a.parse("A.java", "")._unsafeUnwrap()[0]?.specifier).toBe("java:A.java");
    expect(a.parse("a.py", "").isErr()).toBe(true);
    expect(a.resolve("A.java", "s")).toEqual({ type: "external", name: "java:s" });
    expect(a.resolve("package.json", "s")).toEqual({ type: "external", name: "ts:s" });
    expect(a.notes()).toEqual(["ts note", "java note"]);
    expect(a.symbols("a.ts", "")._unsafeUnwrap()).toEqual({ exports: [], reexports: [], imports: [] });
    expect(analyzersId(["oxc/1", "java/1"])).toBe("oxc/1+java/1");
  });

  test("the workspaces of several builds: first claim of a directory wins; a failure fails all", async () => {
    const npm = {
      packages: async () =>
        ok([
          { name: "web", dir: "web" },
          { name: "root", dir: "." },
        ]),
    };
    const java = {
      packages: async () =>
        ok([
          { name: "svc", dir: "svc", build: "maven" as const },
          { name: "agg", dir: "." },
        ]),
    };
    expect((await new MergedWorkspace([npm, java]).packages())._unsafeUnwrap().map((p) => p.name)).toEqual([
      "web",
      "root",
      "svc",
    ]);
    const failing = { packages: async () => err(new MetatorError("INVALID_CONFIG", "x")) };
    expect((await new MergedWorkspace([npm, failing]).packages()).isErr()).toBe(true);
  });
});
