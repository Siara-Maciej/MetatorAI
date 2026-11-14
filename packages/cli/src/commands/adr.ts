import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { failWhen } from "../outcome.ts";

export function registerAdrCommands(program: Command, { action, container }: CommandContext): void {
  meta(program.command("adr").description("Architecture decision records").command("lint"), {
    audience: "ci",
    reads: true,
    check: [],
  })
    .description("Numbering, status, sections, index, and Accepted ADRs naming the rules they imply")
    .action(
      action(async () => {
        return failWhen(
          await container().resolve("lintAdrs").execute(),
          (r) => {
            const errors = r.problems.filter((p) => p.severity === "error").length;
            return (
              errors > 0 && {
                message: `${errors} ADR problem(s)`,
                hint: "Fix the listed ADRs or docs/adr/README.md; only a human marks an ADR Accepted.",
              }
            );
          },
          (r) => r.problems.filter((p) => p.severity === "warning").map((p) => `${p.file}: ${p.message}`),
        );
      }),
    );
}
