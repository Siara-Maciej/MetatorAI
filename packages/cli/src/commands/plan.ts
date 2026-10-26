import { err, MetatorError, normalizePath, ok, PlanDocument } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerPlanCommands(program: Command, { action, container }: CommandContext): void {
  const plan = program
    .command("plan")
    .description("Implementation plans: lint before the build, scope for the hooks and shards");

  plan
    .command("lint")
    .description(
      "Schema, step order, task scope, exemplars from the pattern index, tests first, graph order, deletions",
    )
    .argument("<file>", "plan JSON, e.g. .metator/runs/<id>/plan.json")
    .action(
      action(async (file: string) => {
        const report = await container()
          .resolve("lintPlan")
          .execute({ file: normalizePath(file) });
        if (report.isErr()) return { result: report };
        const errors = report.value.problems.filter((p) => p.severity === "error").length;
        if (errors > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${errors} plan problem(s)`, {
                hint: "Fix the plan before the build; `metator similar --file <path>` finds an exemplar for a created file.",
                details: { ...report.value },
              }),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );

  plan
    .command("scope")
    .description("Write the edit scope and independent shards (plan-scope.json next to the plan)")
    .argument("<file>", "plan JSON")
    .option("--out <file>", "where to write the PlanScope document")
    .action(
      action(async (file: string, opts: { out?: string }) => ({
        result: await container()
          .resolve("scopePlan")
          .execute({ file: normalizePath(file), ...(opts.out ? { out: normalizePath(opts.out) } : {}) }),
      })),
    );

  plan
    .command("schema")
    .description("Print the JSON Schema of a plan")
    .action(action(() => ({ result: ok(PlanDocument.jsonSchema("input")) })));
}
