/** The checked-out branch and the same branch on `origin`: whether a run's work is published. */
export interface PublishedBranch {
  readonly branch: string;
  /** The commit checked out. */
  readonly head: string;
  /** The commit of the same branch on `origin`; null when origin has no such branch. */
  readonly remote: string | null;
  /** Changed or untracked (non-ignored) files not committed (repo-relative). */
  readonly uncommitted: readonly string[];
}

/**
 * Why the work is not published yet, or undefined when origin holds exactly what is checked out:
 * nothing left uncommitted, and the branch on origin at the same commit.
 */
export function publicationProblem(p: PublishedBranch): string | undefined {
  if (p.uncommitted.length > 0)
    return `not committed: ${p.uncommitted.slice(0, 5).join(", ")}${p.uncommitted.length > 5 ? ", …" : ""} (git add -A, then git commit)`;
  if (p.remote === null) return `origin has no branch ${p.branch}: git push -u origin ${p.branch}`;
  if (p.remote !== p.head)
    return `origin's ${p.branch} is at ${p.remote.slice(0, 7)}, the branch at ${p.head.slice(0, 7)}: push again`;
  return undefined;
}
