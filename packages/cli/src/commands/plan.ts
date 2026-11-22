import { err, MetatorError, normalizePath, ok, PlanDocument } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";
import { failWhen, schemaCommand } from "../outcome.ts";

export function registerPlanCommands(program: Command, { action, container }: CommandContext): void {
  const plan = program
    .command("plan")
    .description("Implementation plans: lint before the build, scope for the hooks and shards");

  meta(plan.command("lint"), { reads: true })
    .description(
      "Schema, step order, task scope, exemplars from the pattern index, tests first, graph order, deletions",
    )
    .argument("<file>", "plan JSON, e.g. .metator/runs/<id>/plan.json")
    .action(
      action(async (file: string) => {
        return failWhen(
          await container()
            .resolve("lintPlan")
            .execute({ file: normalizePath(file) }),
          (r) => {
            const errors = r.problems.filter((p) => p.severity === "error").length;
            return (
              errors > 0 && {
                message: `${errors} plan problem(s)`,
                hint: "Fix the plan before the build; `metator similar --file <path>` finds an exemplar for a created file.",
              }
            );
          },
        );
      }),
    );

  meta(plan.command("scope"), { reads: true, typed: true, writesWith: ["--out"], readsWith: ["--dry-run"] })
    .description("Write the edit scope and independent shards (plan-scope.json next to the plan)")
    .argument("<file>", "plan JSON")
    .option("--out <file>", "where to write the PlanScope document")
    .option("--dry-run", "print the scope without writing it", false)
    .action(
      action(async (file: string, opts: { out?: string; dryRun: boolean }) => {
        if (opts.dryRun && opts.out)
          return { result: err(MetatorError.usage("--dry-run writes nothing: leave out --out")) };
        return {
          result: await container()
            .resolve("scopePlan")
            .execute({
              file: normalizePath(file),
              ...(opts.out ? { out: normalizePath(opts.out) } : {}),
              ...(opts.dryRun ? { dryRun: true } : {}),
            }),
        };
      }),
    );

  plan
    .command("done")
    .description(
      "Check one step: run the tests its file and its tests-first reach, and record the result in build-progress.json",
    )
    .argument("<file>", "plan JSON, e.g. .metator/runs/<id>/plan.json")
    .argument("<step>", "the step id, e.g. S3")
    .option("--script <name>", "package.json script that runs tests (files are appended)", "test")
    .option("--timeout <ms>", "time limit for the test run", positiveInt, 600_000)
    .action(
      action(async (file: string, step: string, opts: { script: string; timeout: number }) => {
        const checked = await container()
          .resolve("checkPlanStep")
          .execute({ file: normalizePath(file), step, script: opts.script, timeoutMs: opts.timeout });
        if (checked.isErr()) return { result: checked };
        if (!checked.value.passed)
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `step ${step}: its tests failed (exit ${checked.value.exitCode})`,
                {
                  hint: "Fix the code until they pass, then run this again. Do not change the tests.",
                  details: { ...checked.value },
                },
              ),
            ),
          };
        return { result: ok(checked.value) };
      }),
    );

  meta(plan.command("progress"), { reads: true })
    .description("Every step's checkpoint: passed, failed or pending (build-progress.json)")
    .argument("<file>", "plan JSON")
    .option("--check", "fail unless every step passed (the build stage's gate)", false)
    .action(
      action(async (file: string, opts: { check: boolean }) => {
        const view = await container()
          .resolve("planProgress")
          .execute({ file: normalizePath(file) });
        if (view.isErr()) return { result: view };
        if (opts.check && !view.value.done) {
          const open = view.value.steps.filter((s) => s.status !== "passed");
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `${open.length} step(s) not passed: ${open.map((s) => `${s.id} (${s.status})`).join(", ")}`,
                { hint: "`metator plan done <plan.json> <step>` checks a step.", details: { ...view.value } },
              ),
            ),
          };
        }
        return { result: ok(view.value) };
      }),
    );

  schemaCommand(plan, { action }, "Print the JSON Schema of a plan", PlanDocument);
}
