import { constants, existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { err, MetatorError, ok, type Result, type TreeCopier } from "@metator/core";

/**
 * TreeCopier on node:fs `cp` (F8.7): FICLONE asks for a copy-on-write clone (reflink on btrfs,
 * XFS and APFS) and falls back to a plain copy. Symlinks stay links, as package managers made them.
 */
export class NodeTreeCopier implements TreeCopier {
  async copy(from: string, to: string): Promise<Result<boolean, MetatorError>> {
    if (!existsSync(from) || existsSync(to)) return ok(false);
    try {
      await cp(from, to, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
        mode: constants.COPYFILE_FICLONE,
      });
      return ok(true);
    } catch (e) {
      return err(new MetatorError("COMMAND_FAILED", `copy ${from} to ${to}: ${(e as Error).message}`));
    }
  }
}
