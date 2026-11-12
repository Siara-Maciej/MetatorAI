import { isAbsolute, join, relative, resolve } from "node:path";
import { err, type FileLock, InProcessLock, MetatorError, normalizePath, type Result } from "@metator/core";
import { type LockFileOptions, withLockFile } from "./lock-file.ts";

/**
 * FileLock on lock files next to the files they guard (`<file>.lock`), for a repository rooted at
 * `root`. Callers in this process queue first, so only one of them at a time asks the file system.
 */
export class BunFileLock implements FileLock {
  private readonly queue = new InProcessLock();

  constructor(
    private readonly root: string,
    private readonly options: LockFileOptions = {},
  ) {}

  async hold<T>(
    path: string,
    work: () => Promise<Result<T, MetatorError>>,
  ): Promise<Result<T, MetatorError>> {
    const target = isAbsolute(path) ? resolve(path) : join(this.root, normalizePath(path));
    if (relative(this.root, target).startsWith(".."))
      return err(MetatorError.usage(`Path escapes the repository root: ${path}`));
    return this.queue.hold(target, () => withLockFile(target, work, this.options));
  }
}
