import { err, MetatorError, ok, type Result } from "@metator/core";

/**
 * A file's text in one read, or undefined when there is no such file. Never `exists()` first on
 * the same `Bun.file`: it keeps the size of the file it saw, and when another process renames a
 * new file over it in between, `text()` reads the new file cut to the old size (torn JSON under load).
 */
export async function readTextIfExists(path: string): Promise<Result<string | undefined, MetatorError>> {
  try {
    return ok(await Bun.file(path).text());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok(undefined);
    return err(new MetatorError("COMMAND_FAILED", `cannot read ${path}: ${(e as Error).message}`));
  }
}
