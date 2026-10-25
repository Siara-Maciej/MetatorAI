/**
 * Documentation integrity: every relative link in Markdown resolves to an existing file,
 * and every ADR is listed in the ADR index with a valid status.
 */
import { describe, expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

async function markdownFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const f of new Bun.Glob("**/*.md").scan({ cwd: ROOT })) {
    if (!f.startsWith("node_modules/") && !f.includes("/node_modules/")) files.push(f);
  }
  return files.sort();
}

describe("docs: links", () => {
  test("every relative Markdown link points to an existing file", async () => {
    const broken: string[] = [];
    for (const file of await markdownFiles()) {
      const text = await Bun.file(join(ROOT, file)).text();
      const withoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
      for (const match of withoutCode.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = (match[1] as string).split("#")[0] as string;
        if (target === "" || /^[a-z]+:/i.test(target)) continue;
        if (target.includes("...")) continue; // template placeholders such as ADR-004-...md
        const resolved = join(dirname(join(ROOT, file)), decodeURIComponent(target));
        if (!(await Bun.file(resolved).exists()) && !(await isDirectory(resolved))) {
          broken.push(`${file} → ${target} (${relative(ROOT, resolved)})`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("docs: ADRs", () => {
  test("every ADR file is in the index, and the index lists no missing ADR", async () => {
    const index = await Bun.file(join(ROOT, "docs/adr/README.md")).text();
    const onDisk: string[] = [];
    for await (const f of new Bun.Glob("[0-9][0-9][0-9][0-9]-*.md").scan({ cwd: join(ROOT, "docs/adr") }))
      onDisk.push(f);
    const indexed = [...index.matchAll(/\]\((\d{4}-[^)]+\.md)\)/g)].map((m) => m[1] as string);
    expect(indexed.sort()).toEqual(onDisk.sort());
  });

  test("every ADR declares a valid status and the index agrees", async () => {
    const index = await Bun.file(join(ROOT, "docs/adr/README.md")).text();
    for await (const f of new Bun.Glob("[0-9][0-9][0-9][0-9]-*.md").scan({ cwd: join(ROOT, "docs/adr") })) {
      const text = await Bun.file(join(ROOT, "docs/adr", f)).text();
      const status = text.match(/^- Status: (Proposed|Accepted|Deprecated|Superseded by .+)$/m)?.[1];
      expect(status, `${f} has no valid status line`).toBeDefined();
      const row = index.split("\n").find((l) => l.includes(`(${f})`)) ?? "";
      const short = (status as string).startsWith("Superseded") ? "Superseded" : (status as string);
      expect(row, `index row for ${f} must say ${short}`).toContain(short);
    }
  });
});

async function isDirectory(path: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
