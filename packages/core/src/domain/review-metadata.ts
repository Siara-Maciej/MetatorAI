import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * A review's metadata (`pr.json`, `metator review metadata`): the branch against its base, its
 * commits and authors, the files it changes and whether some of them are not committed yet. It
 * comes from git, so the review's coordinator needs no shell to know what it reviews.
 */
export const ReviewMetadataSchema = z.strictObject({
  base: z.string().min(1),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  mergeBase: z.string().nullable(),
  commits: z.array(
    z.strictObject({
      sha: z.string(),
      author: z.string(),
      email: z.string(),
      date: z.string(),
      subject: z.string(),
    }),
  ),
  /** Commit authors, most commits first. */
  authors: z.array(
    z.strictObject({ name: z.string(), email: z.string(), commits: z.number().int().positive() }),
  ),
  files: z.array(z.string()),
  uncommitted: z.boolean(),
});
export type ReviewMetadata = z.output<typeof ReviewMetadataSchema>;

export const ReviewMetadataDocument = defineDocument("ReviewMetadata", { latest: ReviewMetadataSchema });

/** Authors of the commits, by number of commits (then name). */
export function authorsOf(commits: ReviewMetadata["commits"]): ReviewMetadata["authors"] {
  const by = new Map<string, { name: string; email: string; commits: number }>();
  for (const c of commits) {
    const key = c.email.toLowerCase();
    const a = by.get(key) ?? { name: c.author, email: c.email, commits: 0 };
    a.commits++;
    by.set(key, a);
  }
  return [...by.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}
