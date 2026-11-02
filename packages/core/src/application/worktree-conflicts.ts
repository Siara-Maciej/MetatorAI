import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { WorktreeEntry } from "../domain/worktree.ts";
import type { RunMessages } from "./run-messages.ts";
import type { RunRepository } from "./run-repository.ts";
import type { WorktreeRegistry } from "./worktrees.ts";

export interface WorktreeConflict {
  /** The two runs, the earlier-started first. */
  readonly runs: readonly [string, string];
  readonly files: readonly string[];
  /** The run to merge first: the one that started earlier (its change is the base the other rebases on). */
  readonly mergeFirst: string;
}

export interface ConflictReport {
  /** Active runs in worktrees and the files each changed. */
  readonly changes: readonly {
    readonly runId: string;
    readonly worktree: string;
    readonly files: readonly string[];
  }[];
  readonly conflicts: readonly WorktreeConflict[];
  /** Messages sent to both runs of each conflict (`--notify`). */
  readonly notified: readonly string[];
}

/**
 * Conflicts between sessions (P7, D5): two active runs in their own worktrees that changed the
 * same file will clash at merge time. Found before that, from each worktree's changes against the
 * point it branched off, with the merge order that costs least.
 */
export class WorktreeConflicts {
  constructor(
    private readonly runs: Pick<RunRepository, "list" | "load">,
    private readonly registry: Pick<WorktreeRegistry, "get">,
    /** Files a worktree changed since it branched off (committed and not), repo-relative. */
    private readonly changed: (entry: WorktreeEntry) => Promise<Result<readonly string[], MetatorError>>,
    private readonly messages?: Pick<RunMessages, "send">,
  ) {}

  async execute(
    input: { readonly notify?: { readonly by: string } } = {},
  ): Promise<Result<ConflictReport, MetatorError>> {
    const changes: { runId: string; worktree: string; files: readonly string[]; createdAt: string }[] = [];
    for (const runId of await this.runs.list()) {
      const record = await this.runs.load(runId);
      if (record.isErr()) return err(record.error);
      const r = record.value;
      if (r.state.status !== "active" || !r.worktree) continue;
      const entry = await this.registry.get(r.worktree.id);
      if (entry.isErr()) continue; // a worktree removed by hand: no change to compare
      const files = await this.changed(entry.value);
      if (files.isErr()) return err(files.error);
      changes.push({
        runId,
        worktree: r.worktree.id,
        files: [...files.value].sort(),
        createdAt: r.createdAt,
      });
    }
    changes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
    const conflicts: WorktreeConflict[] = [];
    for (let i = 0; i < changes.length; i++)
      for (let j = i + 1; j < changes.length; j++) {
        const a = changes[i] as (typeof changes)[number];
        const b = changes[j] as (typeof changes)[number];
        const shared = a.files.filter((f) => b.files.includes(f));
        if (shared.length > 0)
          conflicts.push({ runs: [a.runId, b.runId], files: shared, mergeFirst: a.runId });
      }
    const notified: string[] = [];
    if (input.notify && this.messages) {
      for (const c of conflicts)
        for (const [to, from] of [
          [c.runs[0], c.runs[1]],
          [c.runs[1], c.runs[0]],
        ] as const) {
          const sent = await this.messages.send({
            from,
            to,
            topic: "shared-file",
            text: `both runs changed ${c.files.join(", ")}; merge ${c.mergeFirst} first, the other rebases on it`,
            refs: [...c.files],
            by: input.notify.by,
          });
          if (sent.isErr()) return err(sent.error);
          notified.push(`${sent.value.id}→${to}`);
        }
    }
    return ok({
      changes: changes.map(({ runId, worktree, files }) => ({ runId, worktree, files })),
      conflicts,
      notified,
    });
  }
}
