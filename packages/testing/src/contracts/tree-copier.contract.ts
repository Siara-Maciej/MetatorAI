import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TreeCopier } from "@metator/core";

/** Every TreeCopier adapter must pass this suite (on the real file system). */
export function treeCopierContract(name: string, make: () => TreeCopier): void {
  describe(`TreeCopier contract: ${name}`, () => {
    test("copies nested files and keeps symlinks as links; the copy is independent", async () => {
      const dir = await mkdtemp(join(tmpdir(), "metator-copy-"));
      await mkdir(join(dir, "a/node_modules/pkg"), { recursive: true });
      await writeFile(join(dir, "a/node_modules/pkg/index.js"), "one");
      await symlink("pkg", join(dir, "a/node_modules/alias"));
      await mkdir(join(dir, "b"));
      const copier = make();
      expect(
        (await copier.copy(join(dir, "a/node_modules"), join(dir, "b/node_modules")))._unsafeUnwrap(),
      ).toBe(true);
      expect(await readFile(join(dir, "b/node_modules/pkg/index.js"), "utf8")).toBe("one");
      expect(await readlink(join(dir, "b/node_modules/alias"))).toBe("pkg");
      await writeFile(join(dir, "b/node_modules/pkg/index.js"), "two");
      expect(await readFile(join(dir, "a/node_modules/pkg/index.js"), "utf8")).toBe("one");
      // What is there already stays as it is.
      expect(
        (await copier.copy(join(dir, "a/node_modules"), join(dir, "b/node_modules")))._unsafeUnwrap(),
      ).toBe(false);
      expect(await readFile(join(dir, "b/node_modules/pkg/index.js"), "utf8")).toBe("two");
    });

    test("a missing source copies nothing; an unwritable target is an error value", async () => {
      const dir = await mkdtemp(join(tmpdir(), "metator-copy-"));
      expect((await make().copy(join(dir, "none"), join(dir, "out")))._unsafeUnwrap()).toBe(false);
      await mkdir(join(dir, "src"));
      await writeFile(join(dir, "src/f"), "x");
      await writeFile(join(dir, "file"), "not a directory");
      const r = await make().copy(join(dir, "src"), join(dir, "file/inside"));
      expect(r._unsafeUnwrapErr().code).toBe("COMMAND_FAILED");
    });
  });
}
