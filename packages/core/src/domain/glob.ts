import picomatch from "picomatch";

/**
 * Glob matching for `applyTo` / `paths` / scope rules, on top of picomatch (ADR-0010).
 * Paths are repo-relative with forward slashes; dotfiles (e.g. `.github/`) match like any other path.
 */
export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

const cache = new Map<string, (path: string) => boolean>();

function matcher(patterns: readonly string[]): (path: string) => boolean {
  const key = patterns.join("\u0000");
  let match = cache.get(key);
  if (!match) {
    match = picomatch([...patterns], { dot: true });
    cache.set(key, match);
  }
  return match;
}

/** True when `path` matches at least one positive pattern and no `!`-negated pattern. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  const positives = patterns.filter((p) => !p.startsWith("!"));
  if (positives.length === 0) return false;
  const negatives = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const p = normalizePath(path);
  return matcher(positives)(p) && !(negatives.length > 0 && matcher(negatives)(p));
}
