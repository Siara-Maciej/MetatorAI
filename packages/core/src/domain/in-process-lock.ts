import type { MetatorError } from "./errors.ts";
import type { Result } from "./result.ts";

/**
 * One holder at a time per name inside this process, first come first served: a queue, with no
 * I/O. It has the shape of the `FileLock` port, so a store that is given no lock (unit tests on an
 * in-memory file system) still writes one change at a time; the runtime gives the lock that also
 * holds across processes.
 */
export class InProcessLock {
  private readonly tails = new Map<string, Promise<void>>();

  async hold<T>(
    path: string,
    work: () => Promise<Result<T, MetatorError>>,
  ): Promise<Result<T, MetatorError>> {
    const before = this.tails.get(path) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => mine);
    this.tails.set(path, tail);
    await before;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(path) === tail) this.tails.delete(path);
    }
  }
}
