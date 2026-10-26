import { err, MetatorError, normalizePath, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";

export function registerTestCommands(program: Command, { action, container }: CommandContext): void {
  const tests = program.command("test").description("Run the tests a change reaches");

  tests
    .command("affected")
    .description("Tests the import graph says a change reaches, run through the repository's test script")
    .option("--base <ref>", "git ref to compare against", "HEAD")
    .option("--files <files...>", "explicit changed files instead of git")
    .option("--script <name>", "package.json script that runs tests (files are appended)", "test")
    .option("--timeout <ms>", "time limit for the test run", positiveInt, 600_000)
    .action(
      action(async (opts: { base: string; files?: string[]; script: string; timeout: number }) => {
        const run = await container()
          .resolve("runAffectedTests")
          .execute({
            ...(opts.files ? { changed: opts.files.map(normalizePath) } : { base: opts.base }),
            script: opts.script,
            timeoutMs: opts.timeout,
          });
        if (run.isErr()) return { result: run };
        if (!run.value.passed) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `affected tests failed (exit ${run.value.exitCode})`, {
                details: { ...run.value },
              }),
            ),
          };
        }
        return { result: ok(run.value) };
      }),
    );
}
