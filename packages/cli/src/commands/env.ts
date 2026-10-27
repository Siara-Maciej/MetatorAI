import { EnvironmentDocument, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";

/** `env *` (F8.5): how the application starts, started per worktree on its own ports. */
export function registerEnvCommands(program: Command, { action, container }: CommandContext): void {
  const env = program
    .command("env")
    .description("The application's services: discovered, started per worktree, shared where it pays off");

  env
    .command("discover")
    .description(
      "How this repository starts (compose files, start scripts, Procfile, Makefile), with evidence",
    )
    .action(
      action(async () => {
        const r = await container().resolve("discoverEnvironment").execute();
        return { result: r, warnings: r.isOk() ? r.value.warnings : [] };
      }),
    );

  env
    .command("init")
    .description("Write the discovered environment to metator/environment.yml (never overwrites)")
    .option("--dry-run", "print the proposal without writing it", false)
    .action(
      action(async (opts: { dryRun: boolean }) => {
        const r = await container().resolve("initEnvironment").execute({ dryRun: opts.dryRun });
        return { result: r, warnings: r.isOk() ? r.value.warnings : [] };
      }),
    );

  env
    .command("up")
    .description("Start services in order of what they need, and wait until each is ready")
    .argument("[services...]", "services to start (default: every service that is not on-demand)")
    .option("--profile <name>", "start the services of a profile")
    .option("--worktree <id>", "start in this worktree, on its ports (default: this checkout)")
    .action(
      action(async (services: string[], opts: { profile?: string; worktree?: string }) => ({
        result: (
          await container()
            .resolve("environmentServices")
            .up({
              services,
              ...(opts.profile ? { profile: opts.profile } : {}),
              ...(opts.worktree ? { worktree: opts.worktree } : {}),
            })
        ).map((services) => ({ services })),
      })),
    );

  env
    .command("down")
    .description("Stop the services of this checkout or a worktree (shared ones only with --shared)")
    .argument("[services...]", "services to stop (default: all)")
    .option("--worktree <id>", "stop in this worktree")
    .option("--shared", "also stop shared services, which other worktrees may use", false)
    .action(
      action(async (services: string[], opts: { worktree?: string; shared: boolean }) => ({
        result: (
          await container()
            .resolve("environmentServices")
            .down({ services, shared: opts.shared, ...(opts.worktree ? { worktree: opts.worktree } : {}) })
        ).map((stopped) => ({ stopped })),
      })),
    );

  env
    .command("status")
    .description("Each service: where it runs, whether it is up, its ports")
    .option("--worktree <id>", "the services of this worktree")
    .action(
      action(async (opts: { worktree?: string }) => ({
        result: (
          await container()
            .resolve("environmentServices")
            .status(opts.worktree ? { worktree: opts.worktree } : {})
        ).map((services) => ({ services })),
      })),
    );

  env
    .command("logs")
    .description("The last lines a started service wrote")
    .argument("<service>", "service id")
    .option("--worktree <id>", "the service of this worktree")
    .option("--lines <n>", "how many lines", positiveInt, 50)
    .action(
      action(async (service: string, opts: { worktree?: string; lines: number }) => ({
        result: (
          await container()
            .resolve("environmentServices")
            .logs({ service, lines: opts.lines, ...(opts.worktree ? { worktree: opts.worktree } : {}) })
        ).map((text) => ({ service, text })),
      })),
    );

  env
    .command("schema")
    .description("Print the JSON Schema of metator/environment.yml")
    .action(action(() => ({ result: ok(EnvironmentDocument.jsonSchema("input")) })));
}
