import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkoutsOf,
  type FolderRepo,
  foldWorktrees,
  MetatorError,
  parseYamlDocument,
  proposeRepoSet,
  REPO_SET_FILE,
  RepoSetDocument,
  reposOf,
} from "@metator/core";
import { findFolderRepos, findFolderRoot, readCheckout } from "@metator/runtime";
import type { Folder } from "./context.ts";

/**
 * The folder `start` is in (G2, ADR-0057), with its repositories from `metator.repos.yml` or
 * found below it. Worktrees of one repository (`git worktree add ../shop-fix`) are its checkouts,
 * counted once; a listed repository that is a worktree of another listed one is folded into it
 * with a hint.
 */
export function readFolder(start: string): Folder | null {
  const root = findFolderRoot(start);
  if (!root) return null;
  const file = join(root, REPO_SET_FILE);
  if (!existsSync(file)) {
    const found = findFolderRepos(root);
    const branches = new Map(found.flatMap((r) => r.worktrees.map((w) => [w.path, w.branch] as const)));
    const repos = reposOf(proposeRepoSet(found)).repos.map((r) => ({
      ...r,
      worktrees: r.worktrees.map((w) => {
        const branch = branches.get(w.path);
        return branch === undefined ? w : { ...w, branch };
      }),
    }));
    return folderOf(root, repos, null, []);
  }
  const set = parseYamlDocument(readFileSync(file, "utf8"), REPO_SET_FILE).andThen((raw) =>
    RepoSetDocument.parse(raw, REPO_SET_FILE),
  );
  if (set.isErr()) throw set.error;
  const { repos, problems } = reposOf(set.value);
  if (problems.length > 0)
    throw new MetatorError("INVALID_CONFIG", `${REPO_SET_FILE}: ${problems.join("; ")}`);
  const folded = foldWorktrees(repos, (path) => readCheckout(join(root, path)));
  return folderOf(root, folded.repos, file, folded.hints);
}

function folderOf(
  root: string,
  repos: readonly FolderRepo[],
  file: string | null,
  hints: readonly string[],
): Folder {
  return {
    root,
    repos: repos.map((r) => ({
      ...r,
      root: join(root, r.path),
      worktrees: r.worktrees.map((w) => ({ ...w, root: join(root, w.path) })),
    })),
    checkouts: checkoutsOf(repos).map((c) => ({ ...c, root: join(root, c.path) })),
    file,
    hints,
  };
}
