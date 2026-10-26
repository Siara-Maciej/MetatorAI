import { DEFAULT_LCOV, err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";

export function registerCoverageCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("coverage")
    .description("Test coverage of a change")
    .command("diff")
    .description("Coverage of the lines added since a base, from the repo's LCOV report")
    .option("--base <ref>", "git ref to compare against (its merge base with HEAD)", "HEAD")
    .option("--lcov <file>", "LCOV report the tests wrote", DEFAULT_LCOV)
    .option("--min <percent>", "fail when fewer added lines than this are covered", positiveInt)
    .action(
      action(async (opts: { base: string; lcov: string; min?: number }) => {
        const diff = await container().resolve("diffCoverage").execute({ base: opts.base, lcov: opts.lcov });
        if (diff.isErr()) return { result: diff };
        const warnings = diff.value.unmeasured.map((f) => `${f}: added code that no test loaded`);
        if (opts.min !== undefined && diff.value.percent < opts.min) {
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `${diff.value.percent}% of added lines covered, below ${opts.min}%`,
                {
                  hint: "Cover the listed lines with tests, then run the tests with coverage again.",
                  details: { ...diff.value },
                },
              ),
            ),
            warnings,
          };
        }
        return { result: ok(diff.value), warnings };
      }),
    );
}
