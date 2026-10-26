import { join } from "node:path";

/** Shared reading helpers for conformance tests (ADR-0034): they check the repository as it is on disk. */
export const ROOT = join(import.meta.dir, "../..");

/** Repo-relative files matching a glob, sorted. */
export async function files(pattern: string): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of new Bun.Glob(pattern).scan({ cwd: ROOT })) out.push(rel);
  return out.sort();
}

export async function read(path: string): Promise<string> {
  return Bun.file(join(ROOT, path)).text();
}

/** Files and their text, for checks that look at many files at once. */
export async function sources(pattern: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of await files(pattern)) out.set(f, await read(f));
  return out;
}
