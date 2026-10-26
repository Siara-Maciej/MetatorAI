import { err, FindingSetDocument, MetatorError, normalizePath, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerFindingsCommands(program: Command, { action, container }: CommandContext): void {
  const findings = program
    .command("findings")
    .description("Review findings: validate against the code, merge across lenses");

  findings
    .command("validate")
    .description(
      "Schema, policy (blocking needs trigger, reachability, evidence) and quotes checked against the code",
    )
    .argument("<dir>", "directory of FindingSet JSON files, e.g. .metator/runs/<id>/findings")
    .option("--fix", "rewrite the line of findings whose quote moved", false)
    .action(
      action(async (dir: string, opts: { fix: boolean }) => {
        const report = await container()
          .resolve("validateFindings")
          .execute({ dir: normalizePath(dir), fix: opts.fix });
        if (report.isErr()) return { result: report };
        const { invalid, moved } = report.value.counts;
        const unreadable = report.value.unreadable.length;
        if (invalid + moved + unreadable > 0) {
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `${invalid} invalid, ${moved} moved, ${unreadable} unreadable`,
                {
                  hint: "Invalid findings never reach Verify: fix the quote or the missing fields; `--fix` updates moved lines.",
                  details: { ...report.value },
                },
              ),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );

  findings
    .command("merge")
    .description("Drop invalid findings and merge duplicates across lenses into <dir>/merged.json")
    .argument("<dir>", "directory of FindingSet JSON files")
    .action(
      action(async (dir: string) => ({
        result: await container()
          .resolve("mergeFindings")
          .execute({ dir: normalizePath(dir) }),
      })),
    );

  findings
    .command("schema")
    .description("Print the JSON Schema of a findings file")
    .action(action(() => ({ result: ok(FindingSetDocument.jsonSchema("input")) })));
}
