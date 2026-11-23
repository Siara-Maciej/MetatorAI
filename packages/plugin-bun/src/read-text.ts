/**
 * A file's text in one read, or undefined when there is no such file. Never `exists()` first on
 * the same `Bun.file`: it keeps the size of the file it saw, and when another process renames a
 * new file over it in between, `text()` reads the new file cut to the old size (torn JSON under load).
 */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
