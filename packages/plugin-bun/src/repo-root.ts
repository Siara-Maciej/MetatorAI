import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const MARKERS = [".git", "metator.config.ts", "metator.config.json", "metator.config.yml"];
const FOLDER_FILE = "metator.repos.yml";
const isRepo = (dir: string) => MARKERS.some((m) => existsSync(join(dir, m)));

/**
 * Where a repository's runs live: a MetatorAI worktree (`<repo>/.metator/wt/<id>`, `worktree new`
 * and `run init --worktree`) keeps its run in the checkout it was made from; any other root keeps
 * its own.
 */
export function runsRootOf(root: string): string {
  const main = /^(.*)\/\.metator\/wt\/[^/]+\/?$/.exec(resolve(root))?.[1];
  return main !== undefined && isRepo(main) ? main : resolve(root);
}

/** Nearest ancestor (including `start`) containing a git repo or a MetatorAI config; else `start`. */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (isRepo(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/**
 * The folder of repositories `start` is in (G2), or undefined inside a repository. A folder has a
 * `metator.repos.yml`, or holds repositories without being one itself. Inside a repository that
 * lies in such a folder, the repository wins.
 */
export function findFolderRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (isRepo(dir)) return undefined;
    if (existsSync(join(dir, FOLDER_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const here = resolve(start);
  return findChildRepos(here).length > 0 ? here : undefined;
}

const SKIP = new Set(["node_modules", ".metator", ".git", "dist", "build", "target", "vendor"]);

/** Folder-relative directories that are repositories, down to `depth` levels; not inside them. */
export function findChildRepos(folder: string, depth = 2): string[] {
  const found: string[] = [];
  const walk = (dir: string, left: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (SKIP.has(name) || name.startsWith(".")) continue;
      const child = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(child).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (isRepo(child)) found.push(relative(folder, child).split("\\").join("/"));
      else if (left > 1) walk(child, left - 1);
    }
  };
  walk(folder, depth);
  return found;
}
