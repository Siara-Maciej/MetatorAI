import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";

/**
 * `metator open` (S5, design/13 §5): the editor of `editor.command` on a run's worktree (or the
 * repository), or on a pane's directory, at a file and line when given. VS Code and its forks
 * reuse their window and get `--goto file:line`.
 */
export function registerOpenCommands(program: Command, { action, runs }: CommandContext): void {
  meta(program.command("open"), { audience: "person" })
    .description(
      "Open a run's worktree (or a pane's directory) in your editor, at a file and line when given",
    )
    .option("--run <id>", "the run whose worktree opens (default: latest)")
    .option("--pane <id>", "a pane: its working directory opens")
    .option("--file <path>", "a file in it (repo-relative)")
    .option("--line <n>", "a line of the file", positiveInt)
    .action(
      action(async (opts: { run?: string; pane?: string; file?: string; line?: number }) => ({
        result: await runs()
          .resolve("openEditor")
          .execute({
            ...(opts.run ? { runId: opts.run } : {}),
            ...(opts.pane ? { paneId: opts.pane } : {}),
            ...(opts.file ? { file: opts.file } : {}),
            ...(opts.line ? { line: opts.line } : {}),
          }),
      })),
    );
}
