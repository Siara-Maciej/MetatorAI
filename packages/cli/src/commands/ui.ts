import { err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { runTui } from "../tui/run.tsx";
import { tuiService } from "../tui/service.ts";

/**
 * `metator ui` (G5, ADR-0060): every session of this repository, or of every repository of a
 * folder, in one full-screen view: progress, questions, apps, conversations, settings.
 */
export function registerUiCommands(program: Command, ctx: CommandContext): void {
  program
    .command("ui")
    .description(
      "The full-screen view: every session, its progress and questions, apps, conversations, settings",
    )
    .action(
      ctx.action(async () => {
        if (!ctx.terminal) {
          return {
            result: err(
              MetatorError.usage(
                "`metator ui` needs a terminal",
                "Use `metator status` for the overview, and `run answer`, `run continue`, `ask` and `env` to act.",
              ),
            ),
          };
        }
        const folder = ctx.folder();
        const service = tuiService({
          containerAt: ctx.containerAt,
          folder,
          root: folder ? folder.root : ctx.container().resolve("root"),
          env: process.env,
        });
        const refreshMs = Number(process.env.METATOR_UI_REFRESH_MS) || undefined;
        return {
          result: ok(
            await runTui(service, {
              write: (t) => ctx.terminal?.raw(t),
              ...(refreshMs ? { refreshMs } : {}),
            }),
          ),
        };
      }),
    );
}
