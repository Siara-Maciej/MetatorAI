/**
 * The design system's utilities carry the prefix `tw:` (ADR-0111): the app's own class names
 * (`hidden`, `grid`, `row`…) mean something else, and an unprefixed utility of the same name (`.hidden
 * { display: none }`) would win over them from the utilities layer. A tree node hidden by the filter
 * vanished that way.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) =>
    statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)],
  );

describe("the design system's stylesheet", () => {
  test("Tailwind's theme and utilities are imported with the prefix tw", () => {
    const css = readFileSync(join(SRC, "ui/theme.css"), "utf8");
    const imports = css.split("\n").filter((l) => /@import "tailwindcss\//.test(l));
    expect(imports).toHaveLength(2);
    for (const l of imports) expect(l).toContain("prefix(tw)");
  });

  test("a component writes Tailwind utilities with the prefix", () => {
    // A utility-looking class without `tw:` in a file that uses `tw:` at all is a slip.
    const slips: string[] = [];
    for (const f of walk(SRC).filter((x) => x.endsWith(".tsx"))) {
      const text = readFileSync(f, "utf8");
      if (!text.includes("tw:")) continue;
      for (const m of text.matchAll(/"([^"]*\btw:[^"]*)"/g))
        for (const c of (m[1] as string).split(/\s+/))
          if (/^(bg|text|border|p[xy]?|m[xyt]?|gap|flex|grid|rounded|min-w|min-h|w|h|z|shadow)(-|$)/.test(c))
            slips.push(`${f.slice(SRC.length + 1)}: ${c}`);
    }
    expect(slips).toEqual([]);
  });
});
