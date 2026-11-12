import { existsSync } from "node:fs";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  err,
  type FileSystem,
  MetatorError,
  matchesAny,
  normalizePath,
  ok,
  type Result,
} from "@metator/core";

const DEFAULT_IGNORES = ["!**/node_modules/**", "!.git/**"];

/** FileSystem adapter on Bun APIs. Paths in and out are repo-relative with forward slashes; absolute paths inside the root are accepted. */
export class BunFileSystem implements FileSystem {
  /**
   * `watch`: told right before the first file is written under `watch.dir` while that directory
   * does not exist yet (the composition root uses it to keep local state out of `git status`).
   */
  constructor(
    private readonly root: string,
    private readonly watch?: { readonly dir: string; readonly created: () => void },
  ) {}

  private announce(target: string): void {
    if (!this.watch) return;
    const dir = join(this.root, this.watch.dir);
    if (!relative(dir, target).startsWith("..") && !existsSync(dir)) this.watch.created();
  }

  async read(path: string): Promise<Result<string, MetatorError>> {
    const target = this.resolve(path);
    if (target.isErr()) return err(target.error);
    const file = Bun.file(target.value);
    if (!(await file.exists())) return err(MetatorError.notFound(`File ${path}`, { path }));
    return ok(await file.text());
  }

  async exists(path: string): Promise<boolean> {
    const target = this.resolve(path);
    return target.isOk() && Bun.file(target.value).exists();
  }

  async glob(patterns: readonly string[]): Promise<readonly string[]> {
    const positives = patterns.filter((p) => !p.startsWith("!"));
    const filters = [...patterns, ...DEFAULT_IGNORES];
    const found = new Set<string>();
    for (const pattern of positives) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: this.root, dot: true, onlyFiles: true })) {
        const rel = normalizePath(path);
        if (matchesAny(rel, filters)) found.add(rel);
      }
    }
    return [...found].sort();
  }

  async write(path: string, content: string): Promise<Result<void, MetatorError>> {
    const target = this.resolve(path);
    if (target.isErr()) return err(target.error);
    try {
      this.announce(target.value);
      await mkdir(dirname(target.value), { recursive: true });
      await Bun.write(target.value, content);
      return ok(undefined);
    } catch (e) {
      return err(
        new MetatorError("INTERNAL", `Cannot write ${path}: ${(e as Error).message}`, { details: { path } }),
      );
    }
  }

  async append(path: string, content: string): Promise<Result<void, MetatorError>> {
    const target = this.resolve(path);
    if (target.isErr()) return err(target.error);
    try {
      this.announce(target.value);
      await mkdir(dirname(target.value), { recursive: true });
      // O_APPEND: the kernel places each write at the end, whoever else writes meanwhile.
      await appendFile(target.value, content);
      return ok(undefined);
    } catch (e) {
      return err(
        new MetatorError("INTERNAL", `Cannot append to ${path}: ${(e as Error).message}`, {
          details: { path },
        }),
      );
    }
  }

  async remove(path: string): Promise<Result<void, MetatorError>> {
    const target = this.resolve(path);
    if (target.isErr()) return err(target.error);
    try {
      await rm(target.value, { force: true });
      return ok(undefined);
    } catch (e) {
      return err(
        new MetatorError("INTERNAL", `Cannot remove ${path}: ${(e as Error).message}`, { details: { path } }),
      );
    }
  }

  private resolve(path: string): Result<string, MetatorError> {
    // An absolute path inside the root (`{runDir}` a host expanded) names the same file as its relative one.
    const target = isAbsolute(path) ? resolve(path) : join(this.root, normalizePath(path));
    return relative(this.root, target).startsWith("..")
      ? err(MetatorError.usage(`Path escapes the repository root: ${path}`))
      : ok(target);
  }
}
