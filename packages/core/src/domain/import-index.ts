import { z } from "zod";
import type { EdgeKind } from "./graph.ts";
import { defineDocument } from "./versioned.ts";

/**
 * Cached import extraction (`.metator/index/imports.json`). Only parsing is cached (per content
 * fingerprint); resolution runs every time, because adding a file can change where an
 * unchanged import resolves to.
 */
const ImportSpecifierSchema = z
  .object({
    specifier: z.string(),
    kind: z.enum(["static", "reexport", "dynamic"]),
    typeOnly: z.boolean(),
  })
  .strict();

export const ImportIndexSchema = z
  .object({
    analyzer: z.string(),
    files: z.record(
      z.string(),
      z.object({ fingerprint: z.string(), imports: z.array(ImportSpecifierSchema) }).strict(),
    ),
  })
  .strict();

export type ImportIndex = z.infer<typeof ImportIndexSchema>;

export const ImportIndexDocument = defineDocument("ImportIndex", { latest: ImportIndexSchema });

export interface PackageRef {
  readonly name: string;
  readonly dir: string;
}

/** The workspace package owning a repo-relative path (deepest matching directory wins). */
export function packageOf(path: string, packages: readonly PackageRef[]): PackageRef | undefined {
  const depth = (dir: string) => (dir === "." ? 0 : dir.split("/").length);
  let best: PackageRef | undefined;
  for (const pkg of packages) {
    const inside = pkg.dir === "." || path === pkg.dir || path.startsWith(`${pkg.dir}/`);
    if (inside && (!best || depth(pkg.dir) > depth(best.dir))) best = pkg;
  }
  return best;
}

export function classifyEdge(from: string, to: string, packages: readonly PackageRef[]): EdgeKind {
  const a = packageOf(from, packages);
  const b = packageOf(to, packages);
  // Two files outside every workspace package both belong to the repository root.
  return a?.dir === b?.dir ? "internal" : "cross-package";
}

/** A package's manifest, repo-relative (`package.json` for the root package, `dir: "."`). */
export function manifestPath(dir: string): string {
  return dir === "." || dir === "" ? "package.json" : `${dir}/package.json`;
}

/** A relative specifier resolved among `files` (with an extension, `.js` written for `.ts`, or `index`). */
export function resolveAmong(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
  extensions: readonly string[],
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return fileAt(parts.join("/"), files, extensions);
}

/** The file of `files` a path written as in an import names: itself, with an extension, or its `index`. */
function fileAt(path: string, files: ReadonlySet<string>, extensions: readonly string[]): string | undefined {
  const stem = path.replace(/\.[cm]?jsx?$/, "");
  const candidates = [
    path,
    ...extensions.map((e) => `${stem}${e}`),
    ...extensions.map((e) => `${path}${e}`),
    ...extensions.map((e) => `${path}/index${e}`),
  ];
  return candidates.find((c) => files.has(c));
}

/**
 * The files of `files` a candidate of an unresolved import names: a path as an import writes it
 * (`src/util`, from a tsconfig alias), or every file under a directory (`packages/money/`, a
 * workspace package imported by name whose file is gone).
 */
export function filesAtCandidate(
  candidate: string,
  files: ReadonlySet<string>,
  extensions: readonly string[],
): string[] {
  if (candidate.endsWith("/")) return [...files].filter((f) => f.startsWith(candidate));
  const file = fileAt(candidate, files, extensions);
  return file ? [file] : [];
}
