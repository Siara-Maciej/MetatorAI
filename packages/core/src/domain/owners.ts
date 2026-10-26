import { matchesAny } from "./glob.ts";

/**
 * CODEOWNERS (`owners`, ADR-0045): who owns a path, for escalation and review. Patterns follow
 * GitHub's rules and are matched as picomatch globs: the last matching line wins, a line without
 * owners leaves the path unowned, `docs/*` does not reach nested files.
 */
export interface CodeownersRule {
  readonly pattern: string;
  readonly owners: readonly string[];
  /** 1-based line in the CODEOWNERS file. */
  readonly line: number;
  readonly globs: readonly string[];
}

/** Where GitHub looks for the file, in its order. */
export const CODEOWNERS_FILES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/** A CODEOWNERS pattern as globs over repo-relative paths. */
export function codeownersGlobs(pattern: string): string[] {
  let p = pattern;
  const directory = p.endsWith("/");
  if (directory) p = p.slice(0, -1);
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\//, "");
  const base = anchored ? p : `**/${p}`;
  // A directory pattern owns everything below it; `dir/*` only the files directly inside.
  const contents = p.endsWith("/*") ? [] : [`${base}/**`];
  return directory ? contents : [base, ...contents];
}

/** Rules of a CODEOWNERS file; comments, blank lines and GitLab section headers are skipped. */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "" || /^\^?\[[^\]]+\]/.test(line)) return;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) return;
    rules.push({ pattern, owners, line: i + 1, globs: codeownersGlobs(pattern) });
  });
  return rules;
}

export interface Ownership {
  readonly path: string;
  readonly owners: readonly string[];
  /** The deciding line, or undefined when no rule matches. */
  readonly rule?: { readonly pattern: string; readonly line: number };
}

export function ownersOf(path: string, rules: readonly CodeownersRule[]): Ownership {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i] as CodeownersRule;
    if (matchesAny(path, r.globs))
      return { path, owners: r.owners, rule: { pattern: r.pattern, line: r.line } };
  }
  return { path, owners: [] };
}
