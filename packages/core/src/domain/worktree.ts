import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * Worktrees of runs (F8.2, ADR-0050): each run works in its own git worktree with its own block
 * of ports, so runs never disturb each other or the person's working tree.
 */
export const WORKTREE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

export const PortBlockSchema = z.strictObject({
  from: z.number().int().min(1024).max(65535),
  count: z.number().int().min(1).max(1000),
});
export type PortBlock = z.output<typeof PortBlockSchema>;

export const WorktreeEntrySchema = z.strictObject({
  id: z.string().regex(WORKTREE_ID),
  /** Repo-relative directory of the worktree. */
  path: z.string().min(1),
  branch: z.string().min(1),
  /** The ref it was created from. */
  base: z.string().min(1),
  /** The run working in it, if any. */
  run: z.string().optional(),
  ports: PortBlockSchema,
  createdAt: z.iso.datetime(),
});
export type WorktreeEntry = z.output<typeof WorktreeEntrySchema>;

export const WorktreeRegistryDocument = defineDocument("WorktreeRegistry", {
  latest: z.strictObject({ worktrees: z.array(WorktreeEntrySchema) }),
  hint: "Written by `metator worktree *` and `metator run init --worktree`; do not edit it by hand.",
});

/** Where port blocks come from: above the usual dev ports, below the ephemeral range. */
export const PORT_RANGE = { from: 41000, to: 48999 } as const;
export const DEFAULT_PORT_COUNT = 20;

const overlaps = (a: PortBlock, b: PortBlock) => a.from < b.from + b.count && b.from < a.from + a.count;

/** Blocks not leased to another worktree, lowest first; the caller probes which are really free. */
export function* candidateBlocks(
  leased: readonly PortBlock[],
  count: number,
  range: { readonly from: number; readonly to: number } = PORT_RANGE,
): Generator<PortBlock> {
  for (let from = range.from; from + count - 1 <= range.to; from += count) {
    const block = { from, count };
    if (!leased.some((l) => overlaps(l, block))) yield block;
  }
}

/** The ports of a block as variables for the processes started in the worktree (`env up`, F8.5). */
export function portVariables(entry: WorktreeEntry): Readonly<Record<string, string>> {
  return {
    METATOR_WORKTREE: entry.id,
    METATOR_PORT_BASE: String(entry.ports.from),
    METATOR_PORT_COUNT: String(entry.ports.count),
  };
}

export interface PruneInput {
  readonly entries: readonly WorktreeEntry[];
  /** Status of each run that still exists; a missing run counts as finished. */
  readonly runStatus: ReadonlyMap<string, string>;
  readonly now: Date;
  readonly olderThanDays: number;
}

/** Worktrees whose run is finished (or gone) and that are older than the limit. Dirty ones are the caller's to skip. */
export function pruneCandidates(input: PruneInput): readonly WorktreeEntry[] {
  const cutoff = input.now.getTime() - input.olderThanDays * 86_400_000;
  return input.entries.filter((e) => {
    if (e.run === undefined) return false;
    const status = input.runStatus.get(e.run);
    const finished = status === undefined || status !== "active";
    return finished && new Date(e.createdAt).getTime() <= cutoff;
  });
}
