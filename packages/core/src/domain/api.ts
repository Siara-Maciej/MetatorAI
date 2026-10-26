import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * Public API of a package (`api snapshot|diff`, ADR-0040): the declaration files (`.d.ts`) the
 * package entry reaches through re-exports, as normalized lines. A refactor that keeps behavior
 * keeps this set; `api diff` names every line that changed.
 */
export const ApiSnapshotSchema = z.strictObject({
  package: z.string(),
  entry: z.string(),
  files: z.array(z.strictObject({ path: z.string(), lines: z.array(z.string()) })),
});
export type ApiSnapshot = z.output<typeof ApiSnapshotSchema>;

export const ApiSnapshotDocument = defineDocument("ApiSnapshot", {
  latest: ApiSnapshotSchema,
  hint: "Write it again with `metator api snapshot <package>`.",
});

/** Declaration lines without comments, private members or layout. */
export function normalizeDeclarations(text: string): string[] {
  const out: string[] = [];
  let inComment = false;
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (inComment) {
      if (line.includes("*/")) {
        inComment = false;
        line = line.slice(line.indexOf("*/") + 2).trim();
      } else continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) {
        inComment = true;
        continue;
      }
      line = line.slice(line.indexOf("*/") + 2).trim();
    }
    if (line.startsWith("//") || line === "") continue;
    if (/^(private|#)/.test(line)) continue; // not callable from outside
    out.push(line.replace(/\s+/g, " "));
  }
  return out;
}

const RELATIVE_FROM = /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g;

/** `x.ts` → `x.d.ts` next to the importer, as tsc names declaration files. */
function declarationOf(fromFile: string, specifier: string): string {
  const dir = fromFile.slice(0, fromFile.lastIndexOf("/") + 1);
  const parts: string[] = [];
  for (const p of `${dir}${specifier}`.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  const path = parts.join("/");
  return path.endsWith(".d.ts") ? path : `${path.replace(/\.(m|c)?(t|j)sx?$/, "")}.d.ts`;
}

/** Declaration files reachable from the entry through re-exports (`export … from "./x"`). */
export function apiSurface(
  pkg: string,
  entry: string,
  declarations: ReadonlyMap<string, string>,
): ApiSnapshot {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file) || !declarations.has(file)) continue;
    seen.add(file);
    for (const line of (declarations.get(file) as string).split("\n")) {
      if (!/^\s*export\b/.test(line)) continue; // imports are not re-exported surface
      for (const [, spec] of line.matchAll(RELATIVE_FROM)) queue.push(declarationOf(file, spec as string));
    }
  }
  return {
    package: pkg,
    entry,
    files: [...seen]
      .sort()
      .map((path) => ({ path, lines: normalizeDeclarations(declarations.get(path) as string) })),
  };
}

export interface ApiDiff {
  readonly changed: boolean;
  readonly addedFiles: readonly string[];
  readonly removedFiles: readonly string[];
  readonly files: readonly {
    readonly path: string;
    readonly added: readonly string[];
    readonly removed: readonly string[];
  }[];
}

/** Lines added and removed per file (as multisets: a moved line is no change). */
export function diffApi(base: ApiSnapshot, current: ApiSnapshot): ApiDiff {
  const before = new Map(base.files.map((f) => [f.path, f.lines]));
  const after = new Map(current.files.map((f) => [f.path, f.lines]));
  const minus = (a: readonly string[], b: readonly string[]) => {
    const left = new Map<string, number>();
    for (const l of b) left.set(l, (left.get(l) ?? 0) + 1);
    return a.filter((l) => {
      const n = left.get(l) ?? 0;
      if (n > 0) left.set(l, n - 1);
      return n === 0;
    });
  };
  const files: { path: string; added: string[]; removed: string[] }[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const added = minus(after.get(path) ?? [], before.get(path) ?? []);
    const removed = minus(before.get(path) ?? [], after.get(path) ?? []);
    if (added.length + removed.length > 0) files.push({ path, added, removed });
  }
  const addedFiles = [...after.keys()].filter((p) => !before.has(p)).sort();
  const removedFiles = [...before.keys()].filter((p) => !after.has(p)).sort();
  return { changed: files.length > 0, addedFiles, removedFiles, files };
}
