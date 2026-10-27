import { HOST_TARGETS, type HostTarget, MetatorConfigDocument, ok } from "@metator/core";
import { type Command, Option } from "commander";
import type { CommandContext } from "../context.ts";

export function registerConfigCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("init")
    .description("Discover the repository and write a proposed metator.config.yml (never overwrites)")
    .option("--dry-run", "print the proposal without writing it", false)
    .addOption(
      new Option("--host <hosts...>", "AI hosts to generate for (default: all)").choices(HOST_TARGETS),
    )
    .action(
      action(async (opts: { dryRun: boolean; host?: HostTarget[] }) => {
        const report = await container()
          .resolve("initProject")
          .execute({ dryRun: opts.dryRun, ...(opts.host ? { hosts: opts.host } : {}) });
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
