import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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

/** FileSystem adapter on Bun APIs. Paths in and out are repo-relative with forward slashes. */
export class BunFileSystem implements FileSystem {
  constructor(private readonly root: string) {}

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
      await mkdir(dirname(target.value), { recursive: true });
      await Bun.write(target.value, content);
      return ok(undefined);
    } catch (e) {
      return err(
        new MetatorError("INTERNAL", `Cannot write ${path}: ${(e as Error).message}`, { details: { path } }),
      );
    }
  }

  private resolve(path: string): Result<string, MetatorError> {
    const target = join(this.root, normalizePath(path));
    return relative(this.root, target).startsWith("..")
      ? err(MetatorError.usage(`Path escapes the repository root: ${path}`))
      : ok(target);
  }
}
