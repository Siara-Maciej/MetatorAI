import { join } from "node:path";
import { parse } from "yaml";

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;

/** Files under the given repo-relative directories that do not declare `kind` + `schemaVersion`. */
export async function findUnversioned(
  root: string,
  dirs: readonly string[],
): Promise<{ checked: number; unversioned: string[] }> {
  const files: string[] = [];
  for (const dir of dirs) {
    for await (const f of new Bun.Glob(`${dir}/**/*`).scan({ cwd: root, dot: true })) files.push(f);
  }
  const unversioned: string[] = [];
  for (const file of files.sort()) {
    const text = await Bun.file(join(root, file)).text();
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
