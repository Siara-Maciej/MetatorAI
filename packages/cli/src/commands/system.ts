import { err, MetatorError, ok, SystemMapDocument } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerSystemCommands(program: Command, { action, container }: CommandContext): void {
  const system = program
    .command("system")
    .description("The system landscape: applications, the contracts between them, deploy order");

  system
    .command("show")
    .description("The system map with each contract's provider and consumers, and the deploy waves")
    .action(action(async () => ({ result: await container().resolve("showSystem").execute() })));

  system
    .command("lint")
    .description("Owners, consumed contracts, contract kinds, deploy cycles and the files in this repository")
    .action(
      action(async () => {
        const report = await container().resolve("lintSystem").execute();
        if (report.isErr()) return { result: report };
        const errors = report.value.problems.filter((p) => p.severity === "error");
        if (errors.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${errors.length} problem(s) in ${report.value.source}`, {
                hint: "Fix the map or the files it names; `metator system schema` prints the format.",
                details: { ...report.value },
              }),
            ),
          };
        }
        const warnings = report.value.problems.filter((p) => p.severity === "warning").map((p) => p.message);
        return { result: ok(report.value), ...(warnings.length > 0 ? { warnings } : {}) };
      }),
    );

  system
    .command("schema")
    .description("Print the JSON Schema of the system map")
    .action(action(async () => ({ result: ok(SystemMapDocument.jsonSchema("input")) })));
}
