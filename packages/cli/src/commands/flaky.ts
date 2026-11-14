import { normalizePath } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";
import { failWhen } from "../outcome.ts";

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
        return failWhen(
          await container()
            .resolve("checkFlaky")
            .execute({ test: normalizePath(test), runs: opts.runs, script: opts.script }),
          (r) =>
            r.failed > 0 && {
              message: r.flaky
                ? `${test} is flaky: ${r.failed} of ${r.runs} runs failed`
                : `${test} failed every run`,
            },
        );
      }),
    );
}
