import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MARKERS = [".git", "metator.config.ts", "metator.config.json"];

/** Nearest ancestor (including `start`) containing a git repo or a MetatorAI config; else `start`. */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}
