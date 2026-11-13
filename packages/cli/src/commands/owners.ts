import { normalizePath } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";

export function registerOwnersCommand(program: Command, { action, container }: CommandContext): void {
  meta(program.command("owners"), { audience: "person", reads: true })
    .description("Owners of each path from CODEOWNERS (last matching line wins), for escalation and review")
    .argument("<paths...>", "repo-relative paths")
    .action(
      action(async (paths: string[]) => {
        const report = await container()
          .resolve("findOwners")
          .execute({ paths: paths.map(normalizePath) });
        return {
          result: report,
          ...(report.isOk() && report.value.source === undefined
            ? { warnings: ["No CODEOWNERS in .github/, the root or docs/: every path is unowned"] }
            : {}),
        };
      }),
    );
}
