import { EvalCaseDocument, err, MetatorError, normalizePath, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt, ratio } from "../options.ts";

export function registerEvalCommands(program: Command, { action, container }: CommandContext): void {
  const evals = program.command("eval").description("Review evals on the golden set: run, score, compare");

  evals
    .command("run")
    .description("Run the headless review for every golden case (and repeat), then score the outputs")
    .requiredOption("--command <template>", "e.g. 'scripts/review-case.sh {case} {base} {head} {out}'")
    .option("--runs-dir <dir>", "where each run writes <case>/<run>/", ".metator/evals")
    .option("--repeat <n>", "runs per case (stability)", positiveInt, 3)
    .option("--timeout-ms <ms>", "per run", positiveInt, 1_800_000)
    .action(
      action(async (opts: { command: string; runsDir: string; repeat: number; timeoutMs: number }) => {
        const c = container();
        const runs = await c.resolve("runEvals").execute({ ...opts, runsDir: normalizePath(opts.runsDir) });
        if (runs.isErr()) return { result: runs };
        const score = await c.resolve("scoreEvals").execute({ runsDir: normalizePath(opts.runsDir) });
        const failed = runs.value.runs
          .filter((r) => r.exitCode !== 0)
          .map((r) => `${r.case}/${r.run} exited ${r.exitCode}`);
        return { result: score.map((s) => ({ ...s, executions: runs.value.runs })), warnings: failed };
      }),
    );

  evals
    .command("score")
    .description("Precision, recall, blocking precision, false blocks and decision variance from run outputs")
    .argument("<runs-dir>", "directory with <case>/<run>/findings/merged.json and verdict.json")
    .action(
      action(async (dir: string) => {
        const score = await container()
          .resolve("scoreEvals")
          .execute({ runsDir: normalizePath(dir) });
        return {
          result: score,
          warnings: score.isOk() ? score.value.missing.map((m) => `no output for ${m}`) : [],
        };
      }),
    );

  evals
    .command("compare")
    .description("Fail when the scores got worse (gate for changes to agents, skills and instructions)")
    .argument("<before>", "EvalReport of the base")
    .argument("<after>", "EvalReport of the change")
    .option("--tolerance <ratio>", "allowed drop per number", ratio, 0.02)
    .action(
      action(async (before: string, after: string, opts: { tolerance: number }) => {
        const report = await container()
          .resolve("compareEvals")
          .execute({ before: normalizePath(before), after: normalizePath(after), tolerance: opts.tolerance });
        if (report.isOk() && report.value.regressions.length > 0) {
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `review quality regressed: ${report.value.regressions.join("; ")}`,
                {
                  hint: "Revert or rework the agent change; prompts are code.",
                  details: { ...report.value },
                },
              ),
            ),
          };
        }
        return { result: report };
      }),
    );

  evals
    .command("schema")
    .description("Print the JSON Schema of a golden eval case")
    .action(action(() => ({ result: ok(EvalCaseDocument.jsonSchema("input")) })));
}
