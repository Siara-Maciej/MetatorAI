import { readFileSync } from "node:fs";
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
    .command("list")
    .description("The golden set: every case with its type, base and head")
    .action(
      action(async () => ({
        result: (await container().resolve("evalCatalog").scan()).map((cases) => ({
          cases: cases.map((c) => ({
            id: c.id,
            type: c.type,
            base: c.base,
            head: c.head,
            ...(c.patch ? { patch: c.patch } : {}),
            expected: c.expected.length,
          })),
          byType: {
            seeded: cases.filter((c) => c.type === "seeded").length,
            bug: cases.filter((c) => c.type === "bug").length,
            clean: cases.filter((c) => c.type === "clean").length,
          },
        })),
      })),
    );

  evals
    .command("seed")
    .description(
      "Write golden cases from the unit suite's mutants (seeded), the commits later fixes repaired (bug) and ordinary commits (clean)",
    )
    .option(
      "--mutants <file>",
      "a JSON array of {file, from, to, why} (scripts/golden-seed.ts writes it from scripts/mutants.ts)",
    )
    .option("--seeded <n>", "how many seeded cases", positiveInt, 30)
    .option("--bugs <n>", "how many bug cases", positiveInt, 10)
    .option("--clean <n>", "how many clean cases", positiveInt, 10)
    .option("--base <ref>", "the ref seeded cases are planted on", "HEAD")
    .option("--history <n>", "how many commits back fixes and clean changes are looked for", positiveInt, 500)
    .action(
      action(
        async (opts: {
          mutants?: string;
          seeded: number;
          bugs: number;
          clean: number;
          base: string;
          history: number;
        }) => {
          let mutants: { file: string; from: string; to: string; why: string }[] = [];
          if (opts.mutants) {
            try {
              mutants = JSON.parse(readFileSync(normalizePath(opts.mutants), "utf8")) as typeof mutants;
            } catch (e) {
              return {
                result: err(MetatorError.usage(`--mutants ${opts.mutants}: ${(e as Error).message}`)),
              };
            }
          }
          return {
            result: await container()
              .resolve("seedGoldenSet")
              .execute({
                mutants,
                seeded: opts.mutants ? opts.seeded : 0,
                bugs: opts.bugs,
                clean: opts.clean,
                base: opts.base,
                history: opts.history,
              }),
          };
        },
      ),
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
