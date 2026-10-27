import { err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { hub } from "../ui.ts";

/** `metator ui` (F8.6): sessions, questions, applications and code of every run, in one place. */
export function registerUiCommands(program: Command, { action, container, terminal }: CommandContext): void {
  program
    .command("ui")
    .description("Sessions in the terminal: switch runs, answer questions, run apps, open the code")
    .action(
      action(async () => {
        if (!terminal) {
          return {
            result: err(
              MetatorError.usage(
                "`metator ui` needs a terminal",
                "Use `metator run list`, `run questions`, `run answer` and `env status` instead.",
              ),
            ),
          };
        }
        const root = (program.opts() as { root?: string }).root;
        return { result: ok(await hub({ c: container(), terminal, root, env: process.env })) };
      }),
    );
}
