import { err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerAdrCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("adr")
    .description("Architecture decision records")
    .command("lint")
    .description("Numbering, status, sections, index, and Accepted ADRs naming the rules they imply")
    .action(
      action(async () => {
        const report = await container().resolve("lintAdrs").execute();
        if (report.isErr()) return { result: report };
        const warnings = report.value.problems
          .filter((p) => p.severity === "warning")
          .map((p) => `${p.file}: ${p.message}`);
        const errors = report.value.problems.filter((p) => p.severity === "error");
        if (errors.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${errors.length} ADR problem(s)`, {
                hint: "Fix the listed ADRs or docs/adr/README.md; only a human marks an ADR Accepted.",
                details: { ...report.value },
              }),
            ),
            warnings,
          };
        }
        return { result: ok(report.value), warnings };
      }),
    );
}
