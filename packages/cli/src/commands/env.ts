import { EnvironmentDocument, err, MetatorError, type Result } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";
import { schemaCommand } from "../outcome.ts";

/** `env *` (F8.5): how the application starts, started per worktree on its own ports. */
export function registerEnvCommands(program: Command, { action, container }: CommandContext): void {
  const env = meta(program.command("env"), { audience: "person" }).description(
    "The application's services: discovered, started per worktree, shared where it pays off",
  );

  env
    .command("discover")
    .description(
      "How this repository starts (compose files, start scripts, Procfile, Makefile), with evidence",
    )
    .action(
      action(async () => {
        const r = await container().resolve("discoverEnvironment").execute();
        // The warnings go out once, in the envelope.
        return {
          result: r.map(({ warnings: _, ...found }) => found),
          warnings: r.isOk() ? r.value.warnings : [],
        };
      }),
    );

  env
    .command("init")
    .description("Write the discovered environment to metator/environment.yml (never overwrites)")
    .option("--dry-run", "print the proposal without writing it", false)
    .action(
      action(async (opts: { dryRun: boolean }) => {
        const r = await container().resolve("initEnvironment").execute({ dryRun: opts.dryRun });
        return {
          result: r.map(({ warnings: _, ...written }) => written),
          warnings: r.isOk() ? r.value.warnings : [],
        };
      }),
    );

  env
    .command("up")
    .description("Start services in order of what they need, and wait until each is ready")
    .argument("[services...]", "services to start (default: every service that is not on-demand)")
    .option("--profile <name>", "start the services of a profile")
    .option("--worktree <id>", "start in this worktree, on its ports (default: this checkout)")
    .option(
      "--affected",
      "start only the services the changes touch (their `paths`), and what they need",
      false,
    )
    .option(
      "--base <ref>",
      "with --affected: compare against this ref (default: where the worktree branched off)",
    )
    .action(
      action(
        async (
          services: string[],
          opts: { profile?: string; worktree?: string; affected: boolean; base?: string },
        ) => {
          const c = container();
          let affected: readonly string[] | undefined;
          if (opts.affected) {
            const files = await changedFiles(c, opts.worktree, opts.base);
            if (files.isErr()) return { result: files };
            affected = files.value;
          }
          return {
            result: (
              await c.resolve("environmentServices").up({
                services,
                ...(opts.profile ? { profile: opts.profile } : {}),
                ...(opts.worktree ? { worktree: opts.worktree } : {}),
                ...(affected ? { affected } : {}),
              })
            ).map((started) => ({ services: started, ...(affected ? { affected } : {}) })),
          };
        },
      ),
    );

  env
    .command("analyze")
    .description("Measure a cold and a warm start in throwaway worktrees and recommend how to start faster")
    .option("--cold", "restart running shared services first, so their start is measured too", false)
    .action(
      action(async (opts: { cold: boolean }) => ({
        result: await container().resolve("analyzeEnvironment").execute({ cold: opts.cold }),
      })),
    );

  env
    .command("pool")
    .description("Worktrees with their services already up; `run new --worktree` takes a free one")
    .option("--size <n>", "keep this many free worktrees started", positiveInt)
    .option("--drain", "stop and remove the free ones", false)
    .action(
      action(async (opts: { size?: number; drain: boolean }) => {
        const pool = container().resolve("warmPool");
        if (opts.drain) return { result: await pool.drain() };
        return { result: opts.size ? await pool.fill(opts.size) : await pool.list() };
      }),
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

  meta(env.command("status"), { reads: true })
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

  schemaCommand(env, { action }, "Print the JSON Schema of metator/environment.yml", EnvironmentDocument);
}

/**
 * The files changed in a place and every file that imports them: in a worktree, what its branch
 * changed since it left this checkout's HEAD (or `base`), committed or not.
 */
async function changedFiles(
  c: MetatorContainer,
  worktree: string | undefined,
  base: string | undefined,
): Promise<Result<readonly string[], MetatorError>> {
  if (!worktree) {
    const r = await c.resolve("computeAffected").execute({ base: base ?? "HEAD" });
    return r.map((a) => a.files);
  }
  const entry = await c.resolve("worktreeRegistry").get(worktree);
  if (entry.isErr()) return err(entry.error);
  const root = c.resolve("root");
  // The ref is this checkout's (its HEAD is where the worktree left from); the files are the worktree's.
  const ref = base ?? "HEAD";
  const head = await c
    .resolve("processRunner")
    .run({ argv: ["git", "rev-parse", "--verify", ref], cwd: root });
  if (head.exitCode !== 0) return err(MetatorError.usage(`Unknown base ref "${ref}"`));
  const changed = await c.resolve("vcsAt")(`${root}/${entry.value.path}`).changedFiles(head.stdout.trim());
  if (changed.isErr()) return err(changed.error);
  const r = await c.resolve("computeAffected").execute({ changed: changed.value });
  return r.map((a) => a.files);
}
