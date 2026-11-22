/**
 * What a checkout is, from its `.git` (G2, ADR-0057): a repository of its own, or a linked
 * worktree of another (`git worktree add ../shop-fix`). A folder counts repositories, so the
 * worktrees of one repository are its checkouts, not more repositories. The adapter reads git's
 * files; the decision is here.
 */

/** How git's files are read: a file's text (undefined when there is none), and whether a path is a directory. */
export interface GitFiles {
  text(path: string): string | undefined;
  isDir(path: string): boolean;
}

export type Checkout =
  /** A `.git` directory, or a gitdir of its own (`--separate-git-dir`): the common dir is that one. */
  | { readonly kind: "repository"; readonly common: string }
  /** A submodule's checkout: its gitdir under the superproject's `.git/modules/`. */
  | { readonly kind: "submodule"; readonly common: string }
  /**
   * A linked worktree: its gitdir has a `commondir`. `main` is the main checkout (the parent of a
   * non-bare common `.git`); a bare repository has none.
   */
  | {
      readonly kind: "worktree";
      readonly common: string;
      readonly main: string | undefined;
      readonly branch: string | undefined;
    }
  /** No `.git` that git would read (a MetatorAI config alone, or a broken pointer). */
  | { readonly kind: "none" };

const slashes = (p: string) => p.replaceAll("\\", "/");

/** `base` joined with `rel` (taken as is when absolute), `.` and `..` folded, forward slashes. */
function joinPath(base: string, rel: string): string {
  const r = slashes(rel.trim());
  const absolute = r.startsWith("/") || /^[A-Za-z]:\//.test(r);
  const whole = absolute ? r : `${slashes(base)}/${r}`;
  const drive = /^[A-Za-z]:/.exec(whole)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of whole.slice(drive.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${drive}/${parts.join("/")}`;
}

const lastPart = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

/** What the checkout in `dir` is, read through `files`. */
export function checkoutOf(dir: string, files: GitFiles): Checkout {
  const root = joinPath(dir, ".");
  const dotGit = `${root === "/" ? "" : root}/.git`;
  if (files.isDir(dotGit)) return { kind: "repository", common: dotGit };
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(files.text(dotGit) ?? "")?.[1];
  if (pointer === undefined) return { kind: "none" };
  const gitdir = joinPath(root, pointer);
  const commondir = files.text(`${gitdir}/commondir`);
  if (commondir === undefined)
    return /\/\.git\/modules\//.test(gitdir)
      ? { kind: "submodule", common: gitdir }
      : { kind: "repository", common: gitdir };
  const common = joinPath(gitdir, commondir);
  const bare = /^\s*bare\s*=\s*true\s*$/im.test(files.text(`${common}/config`) ?? "");
  const branch = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(files.text(`${gitdir}/HEAD`) ?? "")?.[1];
  return {
    kind: "worktree",
    common,
    main: !bare && lastPart(common) === ".git" ? parentOf(common) : undefined,
    branch,
  };
}

/** A checkout found in a folder, by its folder-relative path. */
export interface FoundCheckout {
  readonly path: string;
  readonly checkout: Checkout;
}

/** A worktree of a folder's repository: its folder-relative path and the branch it has out. */
export interface FoundWorktree {
  readonly path: string;
  readonly branch?: string;
}

/** A repository of a folder: the checkout that stands for it, and its other checkouts. */
export interface FoundRepo {
  readonly path: string;
  readonly worktrees: readonly FoundWorktree[];
}

/** One repository, however many checkouts it has: they share a common git directory. */
const repoKey = (f: FoundCheckout) =>
  f.checkout.kind === "none" ? `dir:${f.path}` : `git:${f.checkout.common}`;

/**
 * A folder's checkouts as its repositories: checkouts that share a common git directory are one
 * repository. Its main checkout stands for it; with none in the folder (a bare repository, or a
 * main checkout elsewhere) the first worktree does, and the others are its worktrees.
 */
export function groupCheckouts(found: readonly FoundCheckout[]): FoundRepo[] {
  const sorted = [...found].sort((a, b) => a.path.localeCompare(b.path));
  const groups = new Map<string, FoundCheckout[]>();
  for (const f of sorted) groups.set(repoKey(f), [...(groups.get(repoKey(f)) ?? []), f]);
  const repos: FoundRepo[] = [];
  for (const group of groups.values()) {
    const head = group.find((f) => f.checkout.kind !== "worktree") ?? (group[0] as FoundCheckout);
    // Two checkouts that are each a repository (never the case with git) stay two repositories.
    const others = group.filter((f) => f !== head);
    repos.push({ path: head.path, worktrees: others.filter(isWorktree).map(worktreeOf) });
    for (const f of others.filter((o) => !isWorktree(o))) repos.push({ path: f.path, worktrees: [] });
  }
  return repos.sort((a, b) => a.path.localeCompare(b.path));
}

const isWorktree = (f: FoundCheckout) => f.checkout.kind === "worktree";
const worktreeOf = (f: FoundCheckout): FoundWorktree =>
  f.checkout.kind === "worktree" && f.checkout.branch !== undefined
    ? { path: f.path, branch: f.checkout.branch }
    : { path: f.path };

/** How a worktree is told apart from its repository: `shop (fix-tax)`, else `shop (shop-fix)`. */
export function checkoutLabel(repo: string, worktree: FoundWorktree): string {
  return `${repo} (${worktree.branch ?? lastPart(worktree.path)})`;
}
