/** MT-CODE-010: no dead code. knip (ADR-0112) finds no unused file, export, type or dependency. */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ROOT } from "./lib.ts";

/** One file of knip's JSON report: each kind of issue a list, with a name (and a place in the file). */
const Named = z.object({ name: z.string(), line: z.number().optional() });
const Report = z.object({
  issues: z.array(z.object({ file: z.string() }).catchall(z.unknown())),
});
type Report = z.output<typeof Report>;

/** Every issue of a knip report as one line: `file:line kind name`. */
function problems(report: Report): string[] {
  const out: string[] = [];
  for (const issue of report.issues)
    for (const [kind, value] of Object.entries(issue)) {
      if (kind === "file" || kind === "owners" || !Array.isArray(value)) continue;
      for (const item of value) {
        const named = Named.safeParse(item);
        const name = named.success ? named.data.name : JSON.stringify(item);
        const at = named.success && named.data.line !== undefined ? `:${named.data.line}` : "";
        out.push(`${issue.file}${at} ${kind} ${name}`);
      }
    }
  return out;
}

describe("MT-CODE-010", () => {
  test("knip finds no unused file, export, type or dependency", () => {
    const run = Bun.spawnSync(["bunx", "knip", "--no-progress", "--reporter", "json"], {
      cwd: ROOT,
      stderr: "pipe",
    });
    const text = run.stdout.toString();
    expect([run.exitCode === 0 || text.startsWith("{"), run.stderr.toString().trim()]).toEqual([true, ""]);
    expect(problems(Report.parse(JSON.parse(text)))).toEqual([]);
  });

  test("rejects an unused export, an unused file and an unused dependency, each on its own line", () => {
    const report: Report = {
      issues: [
        {
          file: "packages/core/src/domain/x.ts",
          owners: [],
          exports: [{ name: "unused", line: 3, col: 14 }],
          types: [],
          files: [],
        },
        { file: "scripts/old.ts", owners: [], files: [{ name: "scripts/old.ts" }] },
        { file: "packages/core/package.json", owners: [], devDependencies: [{ name: "left-pad", line: 9 }] },
      ],
    };
    expect(problems(report)).toEqual([
      "packages/core/src/domain/x.ts:3 exports unused",
      "scripts/old.ts files scripts/old.ts",
      "packages/core/package.json:9 devDependencies left-pad",
    ]);
  });
});
