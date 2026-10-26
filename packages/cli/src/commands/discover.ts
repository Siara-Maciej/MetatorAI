import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerDiscoverCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("discover")
    .description(
      "Facts about the repository with evidence: package manager, workspaces, scripts, tools, CI, AI files",
    )
    .action(
      action(async () => {
        const discovery = await container().resolve("discover").execute();
        return { result: discovery, warnings: discovery.isOk() ? discovery.value.warnings : [] };
      }),
    );
}
