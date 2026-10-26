import { MetatorConfigDocument, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerConfigCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("init")
    .description("Discover the repository and write a proposed metator.config.yml (never overwrites)")
    .option("--dry-run", "print the proposal without writing it", false)
    .action(
      action(async (opts: { dryRun: boolean }) => {
        const report = await container().resolve("initProject").execute({ dryRun: opts.dryRun });
        return { result: report, warnings: report.isOk() ? report.value.warnings : [] };
      }),
    );

  const config = program
    .command("config")
    .description("The repository's metator.config, layered over defaults");

  config
    .command("show")
    .description("Resolved configuration and where it came from")
    .action(
      action(() => {
        const c = container();
        const { config: loaded, source } = c.resolve("config");
        return {
          result: ok({
            source: source ?? null,
            paths: c.resolve("paths"),
            sourceIgnores: c.resolve("sourceIgnores"),
            testGlobs: c.resolve("testGlobs"),
            gates: loaded.gates,
          }),
        };
      }),
    );

  config
    .command("schema")
    .description("Print the JSON Schema of metator.config")
    .action(action(() => ({ result: ok(MetatorConfigDocument.jsonSchema("input")) })));
}
