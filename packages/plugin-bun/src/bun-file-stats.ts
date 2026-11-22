import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { FileStat, FileStats } from "@metator/core";

/** FileStats on Node's file system: a repo-relative path is read under the root; links are followed. */
export class BunFileStats implements FileStats {
  constructor(private readonly root: string) {}

  async stat(path: string): Promise<FileStat | undefined> {
    const target = isAbsolute(path) ? path : resolve(this.root, path);
    const info = await stat(target).catch(() => undefined);
    if (!info) return undefined;
    return {
      directory: info.isDirectory(),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      real: await realpath(target),
    };
  }
}
