import { describe, expect, test } from "bun:test";
import type { ImportAnalyzer } from "@metator/core";

/** A repository on disk the analyzer was made for, and what its files import. */
export interface ImportAnalyzerWorld {
  readonly analyzer: ImportAnalyzer;
  /** A file that imports another file of the repository. */
  readonly local: {
    readonly from: string;
    readonly content: string;
    readonly specifier: string;
    readonly file: string;
  };
  /** A file that imports a library (or the language's runtime). */
  readonly external: { readonly from: string; readonly content: string; readonly specifier: string };
  /** Text that is not valid code in the analyzer's language. */
  readonly garbage: string;
}

/**
 * Every ImportAnalyzer adapter must pass this suite (MT-TEST-002, ADR-0107): the import graph
 * caches what `parse` returns by `fingerprint`, then resolves every specifier against the tree,
 * so these hold for every language the graph reads.
 */
export function importAnalyzerContract(name: string, make: () => Promise<ImportAnalyzerWorld>): void {
  describe(`ImportAnalyzer contract: ${name}`, () => {
    test("names the extensions it reads", async () => {
      const { analyzer } = await make();
      expect(analyzer.extensions.length).toBeGreaterThan(0);
      for (const ext of analyzer.extensions) expect(ext).toMatch(/^\.[a-z]+$/);
    });

    test("the fingerprint is stable for the same content and changes with it", async () => {
      const { analyzer, local } = await make();
      const a = analyzer.fingerprint(local.content, local.from);
      expect(analyzer.fingerprint(local.content, local.from)).toBe(a);
      expect(analyzer.fingerprint(`${local.content}\n// changed\n`, local.from)).not.toBe(a);
    });

    test("an import of a repository file is parsed and resolves to that file, repo-relative", async () => {
      const { analyzer, local } = await make();
      const specifiers = analyzer.parse(local.from, local.content)._unsafeUnwrap();
      expect(specifiers.map((s) => s.specifier)).toContain(local.specifier);
      for (const s of specifiers) expect(["static", "reexport", "dynamic"]).toContain(s.kind);
      const resolved = analyzer.resolve(local.from, local.specifier);
      expect(resolved).toEqual({ type: "file", path: local.file });
    });

    test("an import of a library resolves as external, by a name", async () => {
      const { analyzer, external } = await make();
      expect(
        analyzer
          .parse(external.from, external.content)
          ._unsafeUnwrap()
          .map((s) => s.specifier),
      ).toContain(external.specifier);
      const resolved = analyzer.resolve(external.from, external.specifier);
      expect(resolved.type).toBe("external");
      if (resolved.type === "external") expect(resolved.name.length).toBeGreaterThan(0);
    });

    test("invalid code and an unknown specifier are values, never a throw", async () => {
      const { analyzer, local, garbage } = await make();
      const parsed = analyzer.parse(local.from, garbage);
      expect(parsed.isOk() || parsed.error.code === "PARSE_FAILED").toBe(true);
      const unknown = analyzer.resolve(local.from, "./does/not/exist");
      expect(["file", "external", "unresolved"]).toContain(unknown.type);
      expect(unknown.type).not.toBe("file");
    });
  });
}
