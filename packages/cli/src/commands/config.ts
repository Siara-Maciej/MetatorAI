import {
  HOST_TARGETS,
  type HostTarget,
  MetatorConfigDocument,
  OPTION_SCOPES,
  type OptionScope,
  ok,
} from "@metator/core";
import { type Command, Option } from "commander";
import type { CommandContext } from "../context.ts";

export function registerConfigCommands(program: Command, { action, container, runs }: CommandContext): void {
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
        // The warnings go out once, in the envelope.
        return {
          result: report.map(({ warnings: _, ...written }) => written),
          warnings: report.isOk() ? report.value.warnings : [],
        };
      }),
    );

  const config = program
    .command("config")
    .description("The repository's metator.config and every option: your own, the repository's, a run's");

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
    .description(
      "Print the JSON Schema of metator.config (--options: of the options map, one property per option)",
    )
    .option("--options", "the schema of the options instead", false)
    .action(
      action((opts: { options: boolean }) => ({
        result: ok(
          opts.options ? runs().resolve("optionStore").schema() : MetatorConfigDocument.jsonSchema("input"),
        ),
      })),
    );

  // One Option per command: `makeOptionMandatory` changes the instance it is called on.
  const scope = (mandatory = false) => {
    const o = new Option("--scope <scope>", "which file holds the value").choices(OPTION_SCOPES);
    return mandatory ? o.makeOptionMandatory() : o;
  };

  config
    .command("list")
    .description(
      "Every option with its effective value and source (default, user, repo, run), and the diagnostics",
    )
    .addOption(scope())
    .option("--changed", "only the options a file sets", false)
    .option("--run <id>", "with this run's overrides")
    .action(
      action(async (opts: { scope?: OptionScope; changed: boolean; run?: string }) => ({
        result: await runs()
          .resolve("optionStore")
          .list({
            ...(opts.scope ? { scope: opts.scope } : {}),
            changed: opts.changed,
            ...(opts.run ? { runId: opts.run } : {}),
          }),
      })),
    );

  config
    .command("get <key>")
    .description("One option: its value, where it comes from and what each scope holds")
    .option("--run <id>", "with this run's overrides")
    .action(
      action(async (key: string, opts: { run?: string }) => ({
        result: await runs()
          .resolve("optionStore")
          .get(key, { ...(opts.run ? { runId: opts.run } : {}) }),
      })),
    );

  config
    .command("set <key> <value>")
    .description(
      "Set an option in your file (user), the repository's config (repo) or a run (run); lists as a, b, c; a bad value is refused",
    )
    .addOption(scope(true))
    .option("--run <id>", "the run, for --scope run")
    .action(
      action(async (key: string, value: string, opts: { scope: OptionScope; run?: string }) => ({
        result: await runs()
          .resolve("optionStore")
          .set({ key, scope: opts.scope, text: value, ...(opts.run ? { runId: opts.run } : {}) }),
      })),
    );

  config
    .command("unset <key>")
    .description("Remove an option from a scope's file, so the next scope down or the default applies")
    .addOption(scope(true))
    .option("--run <id>", "the run, for --scope run")
    .action(
      action(async (key: string, opts: { scope: OptionScope; run?: string }) => ({
        result: await runs()
          .resolve("optionStore")
          .unset({ key, scope: opts.scope, ...(opts.run ? { runId: opts.run } : {}) }),
      })),
    );
}
