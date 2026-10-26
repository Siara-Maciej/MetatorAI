import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { SourceFiles } from "../src/application/source-files.ts";
import { SymbolQueries } from "../src/application/symbols.ts";
import { ok } from "../src/domain/result.ts";
import { callersOf, findSymbol, type ModuleSymbols, type ResolvedModule } from "../src/domain/symbols.ts";
import type { ImportAnalyzer, SymbolAnalyzer, Vcs } from "../src/ports/index.ts";

type M = Partial<ResolvedModule>;
const mod = (m: M): ResolvedModule => ({ exports: [], reexports: [], imports: [], ...m });
const exp = (name: string, line = 1) => ({ name, line, typeOnly: false });
const imp = (target: string, imported: string, local = imported, line = 1) => ({
  specifier: target,
  target,
  imported,
  local,
  line,
  typeOnly: false,
});
const re = (target: string, imported: string, exported: string) => ({
  specifier: target,
  target,
  imported,
  exported,
  line: 1,
});

describe("findSymbol", () => {
  test("local exports only, sorted; re-exports are not definitions", () => {
    const modules = new Map([
      ["b.ts", mod({ exports: [exp("pay", 4)] })],
      ["a.ts", mod({ exports: [exp("pay", 2)] })],
      ["index.ts", mod({ reexports: [re("a.ts", "pay", "pay")] })],
    ]);
    expect(findSymbol("pay", modules).map((d) => `${d.file}:${d.line}`)).toEqual(["a.ts:2", "b.ts:4"]);
    expect(findSymbol("nope", modules)).toEqual([]);
  });
});

describe("callersOf", () => {
  test("direct imports, named and star re-export chains, renames and namespace imports", () => {
    const modules = new Map<string, ResolvedModule>([
      ["money.ts", mod({ exports: [exp("add"), exp("sub")] })],
      ["index.ts", mod({ reexports: [re("money.ts", "*", "*")] })],
      ["api.ts", mod({ reexports: [re("index.ts", "add", "plus")] })],
      ["direct.ts", mod({ imports: [imp("money.ts", "add", "add", 3)] })],
      ["barrel.ts", mod({ imports: [imp("index.ts", "add")] })],
      ["renamed.ts", mod({ imports: [imp("api.ts", "plus", "p")] })],
      ["ns.ts", mod({ imports: [imp("index.ts", "*", "m")] })],
      ["other.ts", mod({ imports: [imp("money.ts", "sub"), imp("api.ts", "add")] })],
    ]);
    const { callers, providers } = callersOf("add", "money.ts", modules);
    expect(callers.map((c) => `${c.file}:${c.local}:${c.via}:${c.namespace}`)).toEqual([
      "barrel.ts:add:index.ts:false",
      "direct.ts:add:money.ts:false",
      "ns.ts:m:index.ts:true",
      "renamed.ts:p:api.ts:false",
    ]);
    expect(providers).toEqual([
      { file: "api.ts", name: "plus" },
      { file: "index.ts", name: "add" },
      { file: "money.ts", name: "add" },
    ]);
  });

  test("export * skips default; export * as ns does not re-export the name; cycles terminate", () => {
    const modules = new Map<string, ResolvedModule>([
      ["a.ts", mod({ exports: [exp("default")], reexports: [re("b.ts", "*", "*")] })],
      ["b.ts", mod({ reexports: [re("a.ts", "*", "*")] })],
      ["c.ts", mod({ reexports: [re("a.ts", "*", "nsA")] })],
      ["user.ts", mod({ imports: [imp("b.ts", "default", "d"), imp("c.ts", "default", "e")] })],
    ]);
    expect(callersOf("default", "a.ts", modules).callers).toEqual([]);
  });
});

/** `export const <name>`, `export * from "<t>"`, `import { <name> } from "<t>"` lines. */
const symbols: SymbolAnalyzer = {
  symbols: (_p, content) => {
    const out: {
      exports: ModuleSymbols["exports"][number][];
      reexports: ModuleSymbols["reexports"][number][];
      imports: ModuleSymbols["imports"][number][];
    } = {
      exports: [],
      reexports: [],
      imports: [],
    };
    content.split("\n").forEach((line, i) => {
      const e = /^export const (\w+)/.exec(line);
      if (e) out.exports.push({ name: e[1] as string, line: i + 1, typeOnly: false });
      const r = /^export \* from "(.+)"/.exec(line);
      if (r) out.reexports.push({ specifier: r[1] as string, imported: "*", exported: "*", line: i + 1 });
      const m = /^import \{ (\w+) \} from "(.+)"/.exec(line);
      if (m)
        out.imports.push({
          specifier: m[2] as string,
          imported: m[1] as string,
          local: m[1] as string,
          line: i + 1,
          typeOnly: false,
        });
    });
    return ok(out);
  },
};
const analyzer: ImportAnalyzer = {
  extensions: [".ts"],
  fingerprint: (c) => c,
  parse: () => ok([]),
  resolve: (from, spec) =>
    spec.startsWith("./")
      ? { type: "file", path: `${from.slice(0, from.lastIndexOf("/") + 1)}${spec.slice(2)}.ts` }
      : { type: "external", name: spec },
};
const vcs = (files: string[]): Vcs => ({
  changedFiles: async () => ok([]),
  listFiles: async () => ok(files),
  remoteUrl: async () => ok(undefined),
});

describe("SymbolQueries", () => {
  const files = {
    "src/money.ts": "export const add = 1;",
    "src/tax.ts": "export const add = 2;",
    "src/index.ts": 'export * from "./money"',
    "src/use.ts": 'import { add } from "./index"\nimport { x } from "lodash"',
  };
  const queries = () => {
    const fs = new InMemoryFileSystem(files);
    return new SymbolQueries(new SourceFiles(vcs(Object.keys(files)), fs, []), fs, analyzer, symbols);
  };

  test("find lists definitions and the barrels that re-export them", async () => {
    expect((await queries().find("add"))._unsafeUnwrap()).toEqual({
      name: "add",
      definitions: [
        { file: "src/money.ts", line: 1, typeOnly: false },
        { file: "src/tax.ts", line: 1, typeOnly: false },
      ],
      reexportedBy: ["src/index.ts"],
    });
  });

  test("callers need a single definition: ambiguity is a usage error, absence NOT_FOUND", async () => {
    expect((await queries().callers({ name: "add" }))._unsafeUnwrapErr().code).toBe("USAGE");
    const r = (await queries().callers({ name: "add", file: "src/money.ts" }))._unsafeUnwrap();
    expect(r.callers.map((c) => `${c.file}:${c.line}`)).toEqual(["src/use.ts:1"]);
    expect((await queries().callers({ name: "add", file: "src/tax.ts" }))._unsafeUnwrap().callers).toEqual(
      [],
    );
    expect((await queries().callers({ name: "nope" }))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});
