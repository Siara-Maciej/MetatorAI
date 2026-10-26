import { err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerCardsCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("cards")
    .description("Module cards: generated facts per workspace package, curated sections kept")
    .command("build")
    .description("Write the generated block of every module card (docs/metator/modules)")
    .option("--check", "compare only; fail when a card is missing or out of date", false)
    .action(
      action(async (opts: { check: boolean }) => {
        const report = await container().resolve("buildModuleCards").execute({ check: opts.check });
        if (report.isErr()) return { result: report };
        const r = report.value;
        const warnings = r.orphaned.map(
          (f) => `${f}: card of a package that no longer exists; delete or merge it`,
        );
        const failures = r.invalid.length + (opts.check ? r.stale.length : 0);
        if (failures > 0) {
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `${r.stale.length} stale and ${r.invalid.length} invalid card(s)`,
                {
                  hint: "Run `metator cards build`; keep the header and one generated block in each card.",
                  details: { ...r },
                },
              ),
            ),
            warnings,
          };
        }
        return { result: ok(r), warnings };
      }),
    );
}
