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
