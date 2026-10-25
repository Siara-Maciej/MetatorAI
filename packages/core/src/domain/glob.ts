/**
 * Pure glob matching used for `applyTo` / `paths` / scope rules.
 * Supports `**`, `*`, `?`, `{a,b}` and a leading `!` for negation in `matchesAny`.
 * Paths are repo-relative and use forward slashes.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  let inGroup = false;
  while (i < glob.length) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        const atSegmentStart = i === 0 || glob.charAt(i - 1) === "/";
        const followedBySlash = glob.charAt(i + 2) === "/";
        if (atSegmentStart && followedBySlash) {
          re += "(?:.*/)?"; // `**/` matches zero or more directories
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      inGroup = true;
      re += "(?:";
    } else if (c === "}" && inGroup) {
      inGroup = false;
      re += ")";
    } else if (c === "," && inGroup) {
      re += "|";
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** True when `path` matches at least one positive pattern and no negated (`!`) pattern. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  const p = normalizePath(path);
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (globToRegExp(pattern.slice(1)).test(p)) return false;
    } else if (!matched && globToRegExp(pattern).test(p)) {
      matched = true;
    }
  }
  return matched;
}
