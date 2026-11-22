import { join } from "node:path";
import { parse } from "yaml";

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;

/** Files under the given repo-relative directories that do not declare `kind` + `schemaVersion`. */
export async function findUnversioned(
  root: string,
  dirs: readonly string[],
  /** Globs of files that are not MetatorAI's, e.g. the person's code in run worktrees. */
  ignore: readonly string[] = [],
): Promise<{ checked: number; unversioned: string[] }> {
  const skip = ignore.map((g) => new Bun.Glob(g));
  const files: string[] = [];
  for (const dir of dirs) {
    for await (const f of new Bun.Glob(`${dir}/**/*`).scan({ cwd: root, dot: true }))
      if (!skip.some((g) => g.match(f))) files.push(f);
  }
  const unversioned: string[] = [];
  for (const file of files.sort()) {
    const text = await Bun.file(join(root, file)).text();
    // A log of documents (activity.jsonl, usage.jsonl): every line is one versioned document.
    if (file.endsWith(".jsonl")) {
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      const versioned = (line: string) => {
        try {
          const doc = JSON.parse(line) as { kind?: unknown; schemaVersion?: unknown };
          return typeof doc.kind === "string" && Number.isInteger(doc.schemaVersion);
        } catch {
          return false;
        }
      };
      if (lines.length === 0 || !lines.every(versioned)) unversioned.push(file);
      continue;
    }
    let header: { kind?: unknown; schemaVersion?: unknown } | undefined;
    try {
      if (file.endsWith(".json")) header = JSON.parse(text);
      else if (file.endsWith(".yml") || file.endsWith(".yaml")) header = parse(text);
      else if (file.endsWith(".md")) header = parse(FRONT_MATTER.exec(text)?.[1] ?? "");
    } catch {
      header = undefined;
    }
    if (typeof header?.kind !== "string" || !Number.isInteger(header?.schemaVersion)) unversioned.push(file);
  }
  return { checked: files.length, unversioned };
}
