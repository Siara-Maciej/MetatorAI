import { err, MetatorError, normalizePath, PlanDocument } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
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

  schemaCommand(plan, { action }, "Print the JSON Schema of a plan", PlanDocument);
}
