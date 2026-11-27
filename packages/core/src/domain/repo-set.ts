import { z } from "zod";
import { type Checkout, checkoutLabel, type FoundRepo } from "./git-checkout.ts";
import { defineDocument } from "./versioned.ts";

/**
 * A folder of repositories (G2, ADR-0057): `metator.repos.yml` in the folder that holds them. Each
 * repository keeps its own MetatorAI; the folder only gathers them for the desktop app (`serve`),
 * `status`, `inbox`, `ask` and `repos`. Nothing is shared.
 */
export const REPO_SET_FILE = "metator.repos.yml";

/**
 * The folder itself, where a request names a repository (ADR-0114): the place of the folder's own
 * chats. No repository can have this name (a name starts with a letter or a digit).
 */
export const FOLDER_PLACE = ".";

/** Folder-relative directory, forward slashes, no `..`. */
const FolderPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "a path inside the folder");

const RepoV1Schema = z.strictObject({
  /** Folder-relative directory of the repository, forward slashes, no `..`. */
  path: FolderPath,
  /** How the repository is shown (default: the last part of its path). */
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .optional(),
});

const RepoSchema = RepoV1Schema.extend({
  /**
   * Its other checkouts in the folder (`git worktree add ../shop-fix`), folder-relative: they are
   * the same repository, counted once, and their work is shown under it.
   */
  worktrees: z.array(FolderPath).optional(),
});

export const RepoSetSchema = z.strictObject({
  repos: z.array(RepoSchema).min(1, "list at least one repository"),
});
export type RepoSet = z.output<typeof RepoSetSchema>;

export const RepoSetDocument = defineDocument("RepoSet", {
  history: [
    { schema: z.strictObject({ repos: z.array(RepoV1Schema).min(1, "list at least one repository") }) },
  ],
  latest: RepoSetSchema,
  // A v1 set is a v2 one whose repositories list no worktrees.
  upgrade: (previous) => previous,
  errorCode: "INVALID_CONFIG",
  hint: "`metator repos init` proposes one from the repositories in this folder.",
});

/** A worktree of a folder's repository: the name a request names it by, and its branch. */
export interface FolderWorktree {
  readonly name: string;
  /** Folder-relative path. */
  readonly path: string;
  readonly branch?: string;
}

export interface FolderRepo {
  readonly name: string;
  /** Folder-relative path of the checkout that stands for it (its main checkout when the folder has it). */
  readonly path: string;
  readonly worktrees: readonly FolderWorktree[];
}

const lastPart = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
const trimmed = (p: string) => p.replace(/\/+$/, "");

/** The repositories of a set with their names; duplicate names are a problem. */
export function reposOf(set: RepoSet): { repos: FolderRepo[]; problems: string[] } {
  const named = set.repos.map((r) => ({ name: r.name ?? lastPart(r.path), path: trimmed(r.path), r }));
  const names = named.map((r) => r.name);
  const problems = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))].map(
    (n) => `two repositories are named ${n}; give one of them a \`name\``,
  );
  // A worktree is named by its directory, or by its whole path when that name is taken.
  const taken = new Set(names);
  const repos = named.map(({ name, path, r }) => ({
    name,
    path,
    worktrees: (r.worktrees ?? []).map((w) => {
      const own = lastPart(w);
      const wtName = taken.has(own) ? trimmed(w).replaceAll("/", "-") : own;
      taken.add(wtName);
      return { name: wtName, path: trimmed(w) };
    }),
  }));
  return { repos, problems };
}

/**
 * A listed set with what git says of each checkout: a listed repository that is a worktree of
 * another listed one (a v1 file, written before worktrees were told apart) becomes its worktree,
 * said once as a hint. The repository of worktrees whose main checkout is not listed is the first
 * of them. Every worktree gets the branch it has out.
 */
export function foldWorktrees(
  listed: readonly FolderRepo[],
  checkoutAt: (path: string) => Checkout,
): { repos: FolderRepo[]; hints: string[] } {
  const commonOf = (c: Checkout) => (c.kind === "none" ? undefined : c.common);
  const facts = new Map(listed.map((r) => [r.path, checkoutAt(r.path)]));
  const heads = new Map<string, FolderRepo>();
  // The main checkouts first, so a worktree listed before its repository still joins it.
  for (const r of [...listed].sort((a, b) => rank(facts.get(a.path)) - rank(facts.get(b.path)))) {
    const common = commonOf(facts.get(r.path) as Checkout);
    if (common !== undefined && !heads.has(common)) heads.set(common, r);
  }
  const hints: string[] = [];
  const joined = new Map<string, FolderWorktree[]>();
  const kept = listed.filter((r) => {
    const common = commonOf(facts.get(r.path) as Checkout);
    const head = common === undefined ? undefined : heads.get(common);
    if (!head || head === r) return true;
    joined.set(head.path, [...(joined.get(head.path) ?? []), { name: r.name, path: r.path }]);
    hints.push(`${r.name} is a worktree of ${head.name}; counted once`);
    return false;
  });
  const withBranch = (w: FolderWorktree): FolderWorktree => {
    const c = checkoutAt(w.path);
    return c.kind === "worktree" && c.branch !== undefined ? { ...w, branch: c.branch } : w;
  };
  return {
    repos: kept.map((r) => ({
      ...r,
      worktrees: [...r.worktrees, ...(joined.get(r.path) ?? [])].map(withBranch),
    })),
    hints,
  };
}

const rank = (c: Checkout | undefined) => (c?.kind === "worktree" ? 1 : 0);

/** One checkout of a folder: what a request names it by, its repository, and how it is told apart. */
export interface FolderCheckout {
  readonly name: string;
  readonly path: string;
  /** The repository it is a checkout of. */
  readonly repo: string;
  /** Its repository's name, or `shop (fix-tax)` for a worktree. */
  readonly label: string;
  /** Set on a worktree: the repository it belongs to. */
  readonly worktreeOf?: string;
  readonly branch?: string;
}

/** Every checkout of a folder's repositories, each repository's own first, then its worktrees. */
export function checkoutsOf(repos: readonly FolderRepo[]): FolderCheckout[] {
  return repos.flatMap((r) => [
    { name: r.name, path: r.path, repo: r.name, label: r.name },
    ...r.worktrees.map((w) => ({
      name: w.name,
      path: w.path,
      repo: r.name,
      label: checkoutLabel(r.name, w),
      worktreeOf: r.name,
      ...(w.branch !== undefined ? { branch: w.branch } : {}),
    })),
  ]);
}

/**
 * The set `repos init` proposes: every repository found, by path, with its worktrees; names only
 * where two clash.
 */
export function proposeRepoSet(found: readonly (string | FoundRepo)[]): RepoSet {
  const byPath = new Map<string, FoundRepo>();
  for (const f of found) {
    const repo = typeof f === "string" ? { path: f, worktrees: [] } : f;
    if (!byPath.has(repo.path)) byPath.set(repo.path, repo);
  }
  const sorted = [...byPath.keys()].sort();
  return {
    repos: sorted.map((path) => {
      const clash = sorted.filter((p) => lastPart(p) === lastPart(path)).length > 1;
      const worktrees = (byPath.get(path) as FoundRepo).worktrees.map((w) => w.path);
      return {
        path,
        ...(clash ? { name: path.replaceAll("/", "-") } : {}),
        ...(worktrees.length > 0 ? { worktrees } : {}),
      };
    }),
  };
}
