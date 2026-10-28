import { err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { hub } from "../ui.ts";

/** `metator ui` (F8.6): sessions, questions, applications and code of every run, in one place. */
export function registerUiCommands(
  program: Command,
  { action, container, containerAt, folder, terminal }: CommandContext,
): void {
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
        const f = folder();
        if (!f) {
          const root = (program.opts() as { root?: string }).root;
          return { result: ok(await hub({ c: container(), terminal, root, env: process.env })) };
        }
        // A folder of repositories (G2): pick one, work in it, come back to pick another.
        const visited: string[] = [];
        for (;;) {
          const picked = await terminal.choose<string>(`${f.root} · ${f.repos.length} repositories`, [
            ...f.repos.map((r) => ({ value: r.root, label: r.name, hint: r.path })),
            { value: "quit", label: "Quit" },
          ]);
          if (picked === null || picked === "quit") return { result: ok({ visited }) };
          const r = await hub({ c: containerAt(picked), terminal, root: picked, env: process.env });
          visited.push(...r.visited);
        }
      }),
    );
}
