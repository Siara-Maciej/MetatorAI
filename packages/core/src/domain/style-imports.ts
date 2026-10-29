/**
 * Packages a stylesheet pulls in (`@import "tw-animate-css"`, `@use "pkg/x"`, Tailwind's
 * `@plugin "pkg"`), so a dependency only CSS uses is not reported unused. Relative and absolute
 * paths, URLs and comments are skipped.
 */
const STATEMENT = /@(?:import|use|forward|plugin|reference)\s+(?:url\(\s*)?["']([^"']+)["']/g;

export function stylePackages(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set<string>();
  for (const [, spec] of text.matchAll(STATEMENT)) {
    const s = (spec as string).replace(/^~/, "");
    if (/^(\.|\/|[a-z][a-z0-9+.-]*:)/i.test(s)) continue;
    const parts = s.split("/");
    const name = s.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
    if (name.length > 0 && (!s.startsWith("@") || parts.length > 1)) names.add(name);
  }
  return [...names].sort();
}
