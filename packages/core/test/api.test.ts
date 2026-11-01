import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { ApiSnapshots } from "../src/application/api.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { apiSurface, diffApi, normalizeDeclarations } from "../src/domain/api.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import type { DeclarationEmitter, WorkspaceReader } from "../src/ports/index.ts";

const D = "packages/money/src";

describe("normalizeDeclarations", () => {
  test("drops comments, private members and layout", () => {
    const text = `/**
 * Money.
 */
export declare class Money {
    private readonly cents;
    #secret;
    // note
    add(other:   Money): Money; /* inline */
}
`;
    expect(normalizeDeclarations(text)).toEqual([
      "export declare class Money {",
      "add(other: Money): Money; /* inline */",
      "}",
    ]);
  });
});

describe("apiSurface", () => {
  test("follows export-from chains (any depth, ../ too) and ignores plain imports", () => {
    const files = new Map([
      [
        `${D}/index.d.ts`,
        'export * from "./money.ts";\nexport { tax } from "./tax/index.ts";\nimport type { X } from "./internal.ts";\n',
      ],
      [`${D}/money.d.ts`, "export declare const add: (a: number) => number;\n"],
      [`${D}/tax/index.d.ts`, 'export { tax } from "../rates.ts";\n'],
      [`${D}/rates.d.ts`, "export declare const tax: number;\n"],
      [`${D}/internal.d.ts`, "export type X = 1;\n"],
    ]);
    const snap = apiSurface("@acme/money", `${D}/index.d.ts`, files);
    expect(snap.files.map((f) => f.path)).toEqual([
      `${D}/index.d.ts`,
      `${D}/money.d.ts`,
      `${D}/rates.d.ts`,
      `${D}/tax/index.d.ts`,
    ]);
  });
});

describe("diffApi", () => {
  const snap = (files: Record<string, string[]>) => ({
    package: "p",
    entry: "i.d.ts",
    files: Object.entries(files).map(([path, lines]) => ({ path, lines })),
  });

  test("no change, moved lines and private-only changes are no API change", () => {
    expect(diffApi(snap({ "a.d.ts": ["x", "y"] }), snap({ "a.d.ts": ["y", "x"] })).changed).toBe(false);
  });

  test("added, removed and changed declarations; added and removed files", () => {
    const d = diffApi(
      snap({ "a.d.ts": ["x", "y", "y"], "gone.d.ts": ["g"] }),
      snap({ "a.d.ts": ["x", "y", "z"], "new.d.ts": ["n"] }),
    );
    expect(d).toEqual({
      changed: true,
      addedFiles: ["new.d.ts"],
      removedFiles: ["gone.d.ts"],
      files: [
        { path: "a.d.ts", added: ["z"], removed: ["y"] },
        { path: "gone.d.ts", added: [], removed: ["g"] },
        { path: "new.d.ts", added: ["n"], removed: [] },
      ],
    });
  });
});

describe("ApiSnapshots", () => {
  const workspace: WorkspaceReader = {
    packages: async () => ok([{ name: "@acme/money", dir: "packages/money" }]),
  };
  const emitter = (index: string): DeclarationEmitter => ({
    emit: async () => ok(new Map([[`${D}/index.d.ts`, index]])),
  });
  const manifest = (exports: unknown) => JSON.stringify({ name: "@acme/money", exports });

  test("snapshot writes a versioned document; diff compares against it", async () => {
    const fs = new InMemoryFileSystem({ "packages/money/package.json": manifest({ ".": "./src/index.ts" }) });
    const before = new ApiSnapshots(
      emitter("export declare const add: number;"),
      workspace,
      fs,
      DEFAULT_PATHS,
    );
    const snap = (await before.snapshot({ package: "@acme/money" }))._unsafeUnwrap();
    expect(snap.output).toBe(".metator/api/acme__money.json");
    const saved = JSON.parse((await fs.read(snap.output))._unsafeUnwrap()) as Record<string, unknown>;
    expect([saved.kind, saved.schemaVersion, saved.entry]).toEqual(["ApiSnapshot", 1, `${D}/index.d.ts`]);
    expect((await before.diff({ package: "@acme/money" }))._unsafeUnwrap().changed).toBe(false);
    const after = new ApiSnapshots(
      emitter("export declare const add: string;"),
      workspace,
      fs,
      DEFAULT_PATHS,
    );
    expect((await after.diff({ package: "@acme/money" }))._unsafeUnwrap().files[0]?.added).toEqual([
      "export declare const add: string;",
    ]);
  });

  test("subpath pattern exports: every module they expose is the API", async () => {
    const fs = new InMemoryFileSystem({
      "packages/money/package.json": manifest({ "./*": "./src/**/*.ts" }),
    });
    const many: DeclarationEmitter = {
      emit: async () =>
        ok(
          new Map([
            [`${D}/format/percent.d.ts`, "export declare const percent: (v: number) => string;"],
            [`${D}/round.d.ts`, "export declare const round: (v: number) => number;"],
            ["packages/other/src/x.d.ts", "export declare const x: 1;"],
          ]),
        ),
    };
    const snap = (
      await new ApiSnapshots(many, workspace, fs, DEFAULT_PATHS).current("@acme/money")
    )._unsafeUnwrap();
    expect([snap.entry, snap.files.map((f) => f.path)]).toEqual([
      `${D}/**/*.d.ts`,
      [`${D}/format/percent.d.ts`, `${D}/round.d.ts`],
    ]);
    const none = new ApiSnapshots(
      emitter("x"),
      workspace,
      new InMemoryFileSystem({
        "packages/money/package.json": manifest({ "./*": "./lib/*.js" }),
      }),
      DEFAULT_PATHS,
    );
    expect((await none.current("@acme/money"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("a package that ships its own declarations (types): they are the API, without compiling", async () => {
    const fs = new InMemoryFileSystem({
      "packages/money/package.json": JSON.stringify({
        name: "@acme/money",
        main: "dist/index.js",
        types: "types/index.d.ts",
      }),
      "packages/money/types/index.d.ts": 'export * from "./money";\n',
      "packages/money/types/money.d.ts": "export declare function add(a: number, b: number): number;\n",
      "packages/money/types/unused.d.ts": "export declare const x: 1;\n",
    });
    const notCalled: DeclarationEmitter = {
      emit: async () => err(new MetatorError("BIN_NOT_FOUND", "tsc is not installed")),
    };
    const snap = (
      await new ApiSnapshots(notCalled, workspace, fs, DEFAULT_PATHS).current("@acme/money")
    )._unsafeUnwrap();
    expect([snap.entry, snap.files.map((f) => f.path)]).toEqual([
      "packages/money/types/index.d.ts",
      ["packages/money/types/index.d.ts", "packages/money/types/money.d.ts"],
    ]);
    // A `types` file that is not in the repository (built later): compiled from the sources as before.
    await fs.write(
      "packages/money/package.json",
      JSON.stringify({ main: "src/index.ts", types: "dist/index.d.ts" }),
    );
    expect(
      (
        await new ApiSnapshots(emitter("x"), workspace, fs, DEFAULT_PATHS).current("@acme/money")
      )._unsafeUnwrap().entry,
    ).toBe(`${D}/index.d.ts`);
  });

  test("entries from conditional exports or main; errors as values", async () => {
    for (const exports of [{ ".": { types: "./dist/index.d.ts", import: "./src/index.ts" } }, undefined]) {
      const fs = new InMemoryFileSystem({
        "packages/money/package.json": exports ? manifest(exports) : JSON.stringify({ main: "src/index.ts" }),
      });
      expect(
        (
          await new ApiSnapshots(emitter("x"), workspace, fs, DEFAULT_PATHS).current("@acme/money")
        )._unsafeUnwrap().entry,
      ).toBe(`${D}/index.d.ts`);
    }
    const fs = new InMemoryFileSystem({ "packages/money/package.json": manifest({ ".": "./src/main.ts" }) });
    const api = new ApiSnapshots(emitter("x"), workspace, fs, DEFAULT_PATHS);
    expect((await api.current("@acme/money"))._unsafeUnwrapErr().code).toBe("NOT_FOUND"); // no declarations for main.d.ts
    expect((await api.current("@acme/nope"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    expect((await api.diff({ package: "@acme/money" }))._unsafeUnwrapErr().hint).toContain(
      "metator api snapshot @acme/money",
    );
    const noEntry = new InMemoryFileSystem({ "packages/money/package.json": "{}" });
    expect(
      (
        await new ApiSnapshots(emitter("x"), workspace, noEntry, DEFAULT_PATHS).current("@acme/money")
      )._unsafeUnwrapErr().code,
    ).toBe("INVALID_CONFIG");
    const failing: DeclarationEmitter = {
      emit: async () => err(new MetatorError("BIN_NOT_FOUND", "tsc is not installed")),
    };
    const viaTsc = new ApiSnapshots(
      failing,
      workspace,
      new InMemoryFileSystem({ "packages/money/package.json": manifest({ ".": "./src/index.ts" }) }),
      DEFAULT_PATHS,
    );
    expect((await viaTsc.current("@acme/money"))._unsafeUnwrapErr().code).toBe("BIN_NOT_FOUND");
  });
});
