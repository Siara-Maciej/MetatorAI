import { err, MetatorError, ok, workflowJsonSchema } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerWorkflowCommands(program: Command, { action, container }: CommandContext): void {
  const workflow = program.command("workflow").description("Inspect and validate workflow specs");

  workflow
    .command("list")
    .description("List workflows declared in .github/metator/workflows")
    .action(
      action(async () => {
        const scan = await container().resolve("workflowCatalog").scan();
        return {
          result: ok({
            workflows: scan.workflows.map(({ spec, source }) => ({
              id: spec.id,
              revision: spec.revision,
              stages: spec.stages.map((s) => s.id),
              source,
            })),
          }),
          warnings: scan.problems.map((p) => `${p.source}: ${p.error.message}`),
        };
      }),
    );

  workflow
    .command("lint")
    .description("Every workflow against the 16-section anatomy, with owners and critics in the canon")
    .action(
      action(async () => {
        const report = await container().resolve("lintWorkflows").execute();
        if (report.isErr()) return { result: report };
        const errors = report.value.problems.filter((p) => p.severity === "error");
        if (errors.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${errors.length} workflow problem(s)`, {
                hint: "Each workflow answers the anatomy of docs/design/02-workflows.md §1; `metator workflow schema` prints the format.",
                details: { ...report.value },
              }),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );

  workflow
    .command("validate")
    .description("Validate one spec file, or every spec in the repository")
    .argument("[file]", "repo-relative path to a workflow YAML file")
    .action(
      action(async (file: string | undefined) => {
        const catalog = container().resolve("workflowCatalog");
        if (file) {
          const entry = await catalog.parse(file);
          return { result: entry.map(({ spec, source }) => ({ valid: [{ id: spec.id, source }] })) };
        }
        const scan = await catalog.scan();
        if (scan.problems.length > 0) {
          const problems = scan.problems.map((p) => ({ source: p.source, ...p.error.toJSON() }));
          return {
            result: err(
              new MetatorError("INVALID_CONFIG", `${scan.problems.length} invalid workflow spec(s)`, {
                details: { problems },
              }),
            ),
          };
        }
        return { result: ok({ valid: scan.workflows.map(({ spec, source }) => ({ id: spec.id, source })) }) };
      }),
    );

  workflow
    .command("schema")
    .description("Print the JSON Schema of a workflow spec")
    .action(action(() => ({ result: ok(workflowJsonSchema()) })));
}
