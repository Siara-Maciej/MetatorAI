import { err, MetatorError, normalizePath, ok, PatternDocument } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";

export function registerPatternsCommands(program: Command, { action, container }: CommandContext): void {
  const patterns = program.command("patterns").description("Pattern catalog: occurrences, exemplars, legacy");

  patterns
    .command("scan")
    .description("Find every occurrence of every cataloged pattern and write the pattern index")
    .option("--check", "fail when the catalog has problems (exemplar, occurrences, detection rules)", false)
    .action(
      action(async (opts: { check: boolean }) => {
        const scan = await container().resolve("scanPatterns").execute();
        if (scan.isErr()) return { result: scan };
        const summary = {
          patterns: scan.value.patterns.map((p) => ({
            id: p.id,
            title: p.title,
            exemplar: p.exemplar,
            occurrences: p.occurrences.length,
            byPackage: p.byPackage,
            legacy: p.legacy,
          })),
          problems: scan.value.problems,
        };
        const warnings = scan.value.problems
          .filter((p) => p.severity === "warning")
          .map((p) => `${p.source}: ${p.message}`);
        const errors = scan.value.problems.filter((p) => p.severity === "error");
        if (opts.check && errors.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${errors.length} pattern catalog problem(s)`, {
                hint: "Fix docs/metator/patterns/*.yml or the detection rules; `metator patterns schema` prints the format.",
                details: summary,
              }),
            ),
            warnings,
          };
        }
        return { result: ok(summary), warnings };
      }),
    );

  patterns
    .command("schema")
    .description("Print the JSON Schema of a pattern file")
    .action(action(() => ({ result: ok(PatternDocument.jsonSchema("input")) })));

  program
    .command("similar")
    .description("How we already do this: ranked pattern occurrences for a planned file or a description")
    .option("--file <path>", "repo-relative path of the file you are about to write")
    .argument("[description...]", "what you are about to build")
    .option("--top <n>", "number of matches", positiveInt, 3)
    .action(
      action(async (description: string[], opts: { file?: string; top: number }) => {
        const query = description.join(" ").trim();
        const matches = await container()
          .resolve("findSimilar")
          .execute({
            top: opts.top,
            ...(opts.file ? { target: normalizePath(opts.file) } : {}),
            ...(query ? { query } : {}),
          });
        return { result: matches.map((list) => ({ matches: list })) };
      }),
    );
}
