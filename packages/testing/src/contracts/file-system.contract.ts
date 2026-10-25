import { describe, expect, test } from "bun:test";
import type { FileSystem } from "@metator/core";

export type FileSystemFactory = (files: Readonly<Record<string, string>>) => Promise<FileSystem>;

/**
 * LSP in practice: every FileSystem adapter (in-memory, Node, Bun) must pass this suite.
 * Adapters call it from their own test file with a factory that seeds the given files.
 */
export function fileSystemContract(name: string, make: FileSystemFactory): void {
  describe(`FileSystem contract: ${name}`, () => {
    const seed = {
      "README.md": "# root",
      "packages/a/src/index.ts": "export {};",
      "packages/a/src/index.test.ts": "test",
      "packages/b/src/gen/types.ts": "generated",
    };

    test("read returns content of an existing file", async () => {
      const fs = await make(seed);
      expect((await fs.read("README.md"))._unsafeUnwrap()).toBe("# root");
    });

    test("read of a missing file is a NOT_FOUND error, not a throw", async () => {
      const result = await (await make(seed)).read("missing.ts");
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    });

    test("exists reflects presence", async () => {
      const fs = await make(seed);
      expect(await fs.exists("packages/a/src/index.ts")).toBe(true);
      expect(await fs.exists("packages/a/src/nope.ts")).toBe(false);
    });

    test("glob returns sorted repo-relative paths and honors negation", async () => {
      const fs = await make(seed);
      expect(await fs.glob(["packages/**/*.ts", "!**/gen/**"])).toEqual([
        "packages/a/src/index.test.ts",
        "packages/a/src/index.ts",
      ]);
    });

    test("write then read round-trips", async () => {
      const fs = await make(seed);
      expect((await fs.write("out/report.json", "{}")).isOk()).toBe(true);
      expect((await fs.read("out/report.json"))._unsafeUnwrap()).toBe("{}");
    });
  });
}
