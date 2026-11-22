import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { baseOption } from "../options.ts";
import { failWhen } from "../outcome.ts";

export function registerDebugTagsCommands(program: Command, { action, container }: CommandContext): void {
  meta(program.command("debug-tags").description("Instrumentation markers left in code").command("check"), {
    reads: true,
  })
    .description("No [DEBUG-<hex>] marker in the files changed against a base (or every file without --base)")
    .addOption(baseOption("only files changed against this git ref"))
    .action(
      action(async (opts: { base?: string }) => {
        return failWhen(
          await container()
            .resolve("checkDebugTags")
            .execute(opts.base ? { base: opts.base } : {}),
          (r) =>
            r.tags.length > 0 && {
              message: `${r.tags.length} debug tag(s) left in the code`,
              hint: "Remove the instrumentation (every line with the tag) before the gates.",
            },
        );
      }),
    );
}
