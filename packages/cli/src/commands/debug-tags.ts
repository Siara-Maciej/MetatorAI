import { err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerDebugTagsCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("debug-tags")
    .description("Instrumentation markers left in code")
    .command("check")
    .description("No [DEBUG-<hex>] marker in the files changed against a base (or every file without --base)")
    .option("--base <ref>", "only files changed against this git ref")
    .action(
      action(async (opts: { base?: string }) => {
        const report = await container()
          .resolve("checkDebugTags")
          .execute(opts.base ? { base: opts.base } : {});
        if (report.isErr()) return { result: report };
        if (report.value.tags.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${report.value.tags.length} debug tag(s) left in the code`, {
                hint: "Remove the instrumentation (every line with the tag) before the gates.",
                details: { ...report.value },
              }),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );
}
