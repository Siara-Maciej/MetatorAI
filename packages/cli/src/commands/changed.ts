import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";

export function registerChangedCommand(program: Command, { action, container }: CommandContext): void {
  meta(program.command("changed"), { reads: true })
    .description("Files changed against a git ref (committed on the branch, staged, unstaged, untracked)")
    .option("--base <ref>", "git ref to compare against", "HEAD")
    .action(
      action(async (opts: { base: string }) => {
        const files = await container().resolve("vcs").changedFiles(opts.base);
        return { result: files.map((list) => ({ base: opts.base, files: list })) };
      }),
    );
}
