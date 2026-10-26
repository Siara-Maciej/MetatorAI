import slugify from "@sindresorhus/slugify";
import { z } from "zod";
import { LENSES } from "./finding.ts";
import { packageOf } from "./import-index.ts";
import { defineDocument } from "./versioned.ts";

/** How a review is split (ADR-0032): one shard per package (chunked), lenses run per shard. */
export const ReviewPlanSchema = z.strictObject({
  files: z.array(z.string()),
  lenses: z.array(z.enum(LENSES)),
  shards: z.array(
    z.strictObject({
      id: z.string(),
      package: z.string(),
      files: z.array(z.string()),
      card: z.string().nullable(),
      rules: z.array(z.string()),
    }),
  ),
  /** shards × lenses: how many finder runs the coordinator starts. */
  tasks: z.number().int(),
});
export type ReviewPlan = z.output<typeof ReviewPlanSchema>;

export const ReviewPlanDocument = defineDocument("ReviewPlan", { latest: ReviewPlanSchema });

export const DEFAULT_LENSES = ["logic", "contracts", "conventions", "tests", "security"] as const;

export function shardFiles(
  files: readonly string[],
  packages: readonly { readonly name: string; readonly dir: string }[],
  maxFiles: number,
): { id: string; package: string; files: string[] }[] {
  const byPackage = new Map<string, string[]>();
  for (const f of [...files].sort()) {
    const name = packageOf(f, packages)?.name ?? "(root)";
    byPackage.set(name, [...(byPackage.get(name) ?? []), f]);
  }
  const shards: { id: string; package: string; files: string[] }[] = [];
  for (const [name, list] of [...byPackage].sort(([a], [b]) => a.localeCompare(b))) {
    const base = slugify(name.replace(/^@/, "")) || "root";
    for (let i = 0; i < list.length; i += maxFiles) {
      const part = list.length > maxFiles ? `-${i / maxFiles + 1}` : "";
      shards.push({ id: `${base}${part}`, package: name, files: list.slice(i, i + maxFiles) });
    }
  }
  return shards;
}
