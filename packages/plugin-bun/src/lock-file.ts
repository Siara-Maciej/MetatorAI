import { mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import {
  err,
  FileLockDocument,
  type FileLockHolder,
  MetatorError,
  parseJsonDocument,
  type Result,
  serializeJsonDocument,
} from "@metator/core";

export interface LockFileOptions {
  /** How long to wait for a lock another live process holds (default two minutes). */
  readonly waitMs?: number;
  /**
   * A lock not refreshed for this long holds nothing, whatever its pid says: the pid of a process
   * that died may belong to another one by now (default fifteen seconds; a holder refreshes its
   * lock four times in that time).
   */
  readonly staleMs?: number;
  /** How often a waiting process looks again (default 25 ms, plus jitter). */
  readonly pollMs?: number;
}

const DEFAULTS = { waitMs: 120_000, staleMs: 15_000, pollMs: 25 };

const processLives = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** The holder a lock file names; undefined while it is being written, or when it is not ours to read. */
async function holderOf(lock: string): Promise<FileLockHolder | undefined> {
  try {
    const text = await readFile(lock, "utf8");
    const doc = parseJsonDocument(text, lock).andThen((raw) => FileLockDocument.parse(raw, lock));
    return doc.isOk() ? doc.value : undefined;
  } catch {
    return undefined;
  }
}

async function ageMs(file: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Removes a lock whose process is gone, or that nobody refreshed for `staleMs`. Two waiters must
 * not both remove it (the second would remove the first one's new lock), so the removal itself is
 * taken with an exclusive file and the lock is looked at again inside.
 */
async function removeIfStale(lock: string, staleMs: number): Promise<void> {
  const guard = `${lock}.steal`;
  try {
    await (await open(guard, "wx")).close();
  } catch {
    // Another waiter is removing it; a guard left by one that died is dropped after a while.
    if (((await ageMs(guard)) ?? 0) > 5_000) await rm(guard, { force: true });
    return;
  }
  try {
    if (await isStale(lock, staleMs)) await rm(lock, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
}

async function isStale(lock: string, staleMs: number): Promise<boolean> {
  const age = await ageMs(lock);
  if (age === undefined) return false; // released meanwhile
  const holder = await holderOf(lock);
  return (holder !== undefined && !processLives(holder.pid)) || age > staleMs;
}

/** Creates the lock file for `holder`; false when somebody else's is there. */
async function create(lock: string, holder: FileLockHolder): Promise<boolean> {
  const handle = await open(lock, "wx").catch((e) => (code(e) === "EEXIST" ? undefined : Promise.reject(e)));
  if (!handle) return false;
  try {
    await handle.writeFile(serializeJsonDocument(FileLockDocument.stamp(holder)));
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Runs `work` while this process holds `<file>.lock` (created exclusively, so one process wins),
 * then removes it. Waits for a lock a live process holds; takes over one whose process is gone or
 * that was not refreshed for `staleMs` (the holder refreshes it while it works).
 */
export async function withLockFile<T>(
  file: string,
  work: () => Promise<Result<T, MetatorError>>,
  options: LockFileOptions = {},
): Promise<Result<T, MetatorError>> {
  const { waitMs, staleMs, pollMs } = { ...DEFAULTS, ...options };
  const lock = `${file}.lock`;
  const mine: FileLockHolder = {
    pid: process.pid,
    token: crypto.randomUUID(),
    at: new Date().toISOString(),
  };
  const started = Date.now();
  try {
    await mkdir(dirname(lock), { recursive: true });
    for (;;) {
      if (await create(lock, mine)) break;
      if (await isStale(lock, staleMs)) {
        await removeIfStale(lock, staleMs);
        await Bun.sleep(1);
        continue;
      }
      if (Date.now() - started > waitMs) {
        const holder = await holderOf(lock);
        return err(
          new MetatorError(
            "COMMAND_FAILED",
            `${file} is locked${holder ? ` by process ${holder.pid} since ${holder.at}` : ""}`,
            {
              hint: `Try again when it has finished; if no MetatorAI process works here, delete ${lock}.`,
              details: { lock, ...(holder ? { pid: holder.pid } : {}) },
            },
          ),
        );
      }
      await Bun.sleep(pollMs + Math.random() * pollMs);
    }
  } catch (e) {
    return err(new MetatorError("COMMAND_FAILED", `cannot lock ${file}: ${(e as Error).message}`));
  }
  // Long work (a `git worktree add`) keeps the lock fresh, so nobody takes it for abandoned.
  const refresh = setInterval(
    () => {
      const now = new Date();
      void utimes(lock, now, now).catch(() => {});
    },
    Math.max(1, staleMs / 4),
  );
  try {
    return await work();
  } finally {
    clearInterval(refresh);
    // Only our own lock: one taken over (we were thought dead) belongs to someone else now.
    if ((await holderOf(lock))?.token === mine.token) await rm(lock, { force: true });
  }
}
