import { MetatorError } from "../domain/errors.ts";
import { packageOf } from "../domain/import-index.ts";
import type { Snapshot } from "../domain/issue.ts";
import { type Freshness, freshnessOf } from "../domain/issue-snapshot.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock, ContentHasher, FileSystem, Vcs, WorkspaceReader } from "../ports/index.ts";

export interface IssueSnapshotsDependencies {
  readonly fs: Pick<FileSystem, "read" | "exists">;
  readonly hasher: ContentHasher;
  /** What differs from a commit now in this checkout (committed since, or in the working tree). */
  readonly vcs: Pick<Vcs, "changedFiles">;
  /** HEAD's commit, undefined before the first commit. */
  readonly head: () => Promise<Result<string | undefined, MetatorError>>;
  readonly workspace: WorkspaceReader;
  readonly clock: Clock;
  /** `backlog.staleDays`. */
  readonly staleDays: () => Promise<number>;
}

const inside = (file: string, dirs: readonly string[]) =>
  dirs.some((d) => d === "." || file === d || file.startsWith(`${d}/`));

/**
 * Snapshots of an item's analysis and plan (ADR-0096): taken when the text is recorded (the
 * commit, each cited file hashed, the packages they belong to and what of them had changed
 * already), judged whenever the Backlog is read. Only this checkout counts: other branches and
 * worktrees never make a snapshot stale.
 */
export class IssueSnapshots {
  constructor(private readonly d: IssueSnapshotsDependencies) {}

  async take(file: string, cited: readonly string[]): Promise<Result<Snapshot, MetatorError>> {
    const head = await this.d.head();
    if (head.isErr()) return err(head.error);
    if (!head.value)
      return err(
        MetatorError.usage(
          "the repository has no commit yet: an analysis is made against a commit",
          "Commit first (`git commit`), then record it again.",
        ),
      );
    const packages = await this.d.workspace.packages();
    if (packages.isErr()) return err(packages.error);
    const cites: { path: string; sha256: string }[] = [];
    for (const path of cited) {
      const hash = await this.hash(path);
      if (hash !== "") cites.push({ path, sha256: hash });
    }
    const owners = [...new Set(cites.flatMap((c) => packageOf(c.path, packages.value)?.name ?? []))].sort();
    const dirs = packages.value.filter((p) => owners.includes(p.name)).map((p) => p.dir);
    const changed = await this.d.vcs.changedFiles(head.value);
    const dirty: { path: string; sha256: string }[] = [];
    for (const f of changed.isOk() ? changed.value : [])
      if (inside(f, dirs)) dirty.push({ path: f, sha256: await this.hash(f) });
    return ok({
      file,
      at: this.d.clock.now().toISOString(),
      commit: head.value,
      cites,
      packages: owners,
      ...(dirty.length > 0 ? { dirty } : {}),
    });
  }

  /** Whether the snapshot still holds; a commit this checkout cannot compare to leaves only the hashes. */
  async freshness(snapshot: Snapshot): Promise<Result<Freshness, MetatorError>> {
    const packages = await this.d.workspace.packages();
    if (packages.isErr()) return err(packages.error);
    const changed = await this.d.vcs.changedFiles(snapshot.commit);
    const dirs = packages.value.filter((p) => snapshot.packages.includes(p.name)).map((p) => p.dir);
    // Only what the decision compares is hashed: the cited files and those that had changed then.
    const files = new Set([
      ...snapshot.cites.map((c) => c.path),
      ...(snapshot.dirty ?? []).map((d) => d.path),
    ]);
    const hashes = new Map<string, string>();
    for (const f of files) hashes.set(f, await this.hash(f));
    // Without the commit to compare to, only the cited files' hashes can tell.
    const { dirty: _then, ...hashesOnly } = snapshot;
    return ok(
      freshnessOf({
        snapshot: changed.isOk() ? snapshot : hashesOnly,
        hash: (path) => hashes.get(path) ?? "",
        changed: changed.isOk() ? changed.value : [],
        packageDirs: changed.isOk() ? dirs : [],
        now: this.d.clock.now(),
        staleDays: await this.d.staleDays(),
      }),
    );
  }

  /** The content hash of a repository file, "" when it is not there. */
  private async hash(path: string): Promise<string> {
    if (!(await this.d.fs.exists(path))) return "";
    const text = await this.d.fs.read(path);
    return text.isOk() ? this.d.hasher.sha256(text.value) : "";
  }
}
