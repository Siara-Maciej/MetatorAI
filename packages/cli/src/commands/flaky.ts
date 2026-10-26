import { err, MetatorError, normalizePath, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";

export function registerFlakyCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("flaky")
    .description("Test determinism")
    .command("check")
    .description("Run one test file N times through the repo's test script; mixed results mean flaky")
    .argument("<test>", "test file")
    .option("--runs <n>", "how many runs", positiveInt, 5)
    .option("--script <name>", "package.json script that runs tests (the file is appended)", "test")
    .action(
      action(async (test: string, opts: { runs: number; script: string }) => {
        const report = await container()
          .resolve("checkFlaky")
          .execute({ test: normalizePath(test), runs: opts.runs, script: opts.script });
        if (report.isErr()) return { result: report };
        if (report.value.failed > 0) {
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                report.value.flaky
                  ? `${test} is flaky: ${report.value.failed} of ${report.value.runs} runs failed`
                  : `${test} failed every run`,
                { details: { ...report.value } },
              ),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );
}
