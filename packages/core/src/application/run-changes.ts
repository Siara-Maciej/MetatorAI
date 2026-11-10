import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { type FileDiff, parseUnifiedDiff } from "../domain/review-note.ts";
import type { ChangePatch, ProcessRunner, Vcs } from "../ports/index.ts";
import type { RunRepository } from "./run-repository.ts";

export interface RunChangesDependencies {
  /** The repository's absolute root. */
  readonly root: string;
  readonly repo: Pick<RunRepository, "resolveId" | "load">;
  /** The change reader of a checkout (the repository or a run's worktree). */
  readonly changesAt: (dir: string) => ChangePatch & Pick<Vcs, "changedFiles">;
  readonly runner: Pick<ProcessRunner, "run">;
}

export interface RunChangesView {
  readonly runId: string;
  /** The checkout the change lives in (absolute). */
  readonly dir: string;
  /** What the change is measured against: the repository's HEAD for a worktree, HEAD for the checkout. */
  readonly base: string;
  readonly files: readonly {
    readonly path: string;
    readonly added: number;
    readonly removed: number;
    readonly status: FileDiff["status"];
  }[];
  /** The asked-for file as hunks and lines. */
  readonly diff?: FileDiff;
}

/** MetatorAI's own files are not the change. */
const OWN = [".metator/", ".github/metator/"];

/**
 * `metator review changes`, `GET /runs/:id/review` (S5): the files a run changed with their line
 * counts, and one file's diff as hunks. A run in a worktree is measured against the repository's
 * HEAD at the time of reading (its base branch as it stands); a run in the checkout against HEAD.
 */
export class RunChanges {
  constructor(private readonly d: RunChangesDependencies) {}

  async execute(input: {
    readonly runId?: string;
    readonly file?: string;
  }): Promise<Result<RunChangesView, MetatorError>> {
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const record = await this.d.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const w = record.value.worktree;
    const dir = w ? `${this.d.root}/${w.path}` : this.d.root;
    let base = "HEAD";
    if (w) {
      const head = await this.d.runner.run({ argv: ["git", "rev-parse", "HEAD"], cwd: this.d.root });
      if (head.exitCode === 0 && head.stdout.trim() !== "") base = head.stdout.trim();
    }
    const changes = this.d.changesAt(dir);
    const patch = await changes.patch(base);
    if (patch.isErr()) return err(patch.error);
    const parsed = parseUnifiedDiff(patch.value)
      .filter((f) => !OWN.some((p) => f.path.startsWith(p)))
      .sort((a, b) => a.path.localeCompare(b.path));
    const files = parsed.map((f) => ({ path: f.path, added: f.added, removed: f.removed, status: f.status }));
    const diff = input.file ? parsed.find((f) => f.path === input.file) : undefined;
    return ok({ runId: id.value, dir, base, files, ...(diff ? { diff } : {}) });
  }
}
