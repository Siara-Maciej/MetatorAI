import { err, MetatorError, ok, workflowJsonSchema } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { failWhen } from "../outcome.ts";

export function registerWorkflowCommands(program: Command, { action, container }: CommandContext): void {
  const workflow = program.command("workflow").description("Inspect and validate workflow specs");

  meta(workflow.command("list"), { reads: true })
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

  meta(workflow.command("lint"), { audience: "person", reads: true, check: [] })
    .description("Every workflow against the 16-section anatomy, with owners and critics in the canon")
    .action(
      action(async () => {
        return failWhen(await container().resolve("lintWorkflows").execute(), (r) => {
          const errors = r.problems.filter((p) => p.severity === "error").length;
          return (
            errors > 0 && {
              message: `${errors} workflow problem(s)`,
              hint: "Each workflow answers the anatomy of docs/design/02-workflows.md §1; `metator workflow schema` prints the format.",
            }
          );
        });
      }),
    );

  meta(workflow.command("validate"), { audience: "ci", reads: true, check: [] })
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
