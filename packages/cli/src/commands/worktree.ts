import { portVariables } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { byOption, positiveInt } from "../options.ts";
import { asPerson } from "../who.ts";

export function registerWorktreeCommands(program: Command, { action, container }: CommandContext): void {
  const worktree = meta(program.command("worktree"), { audience: "person" }).description(
    "Git worktrees for runs, each on its own branch with its own block of ports",
  );

  worktree
    .command("new")
    .description("Create .metator/wt/<id> on branch metator/<id> with a free block of ports")
    .argument("<id>", "worktree id (lowercase letters, digits, -)")
    .option("--base <ref>", "ref to branch from", "HEAD")
    .option("--run <id>", "the run that works in it")
    .option("--ports <count>", "how many ports to lease", positiveInt, 20)
    .action(
      action(async (id: string, opts: { base: string; run?: string; ports: number }) => {
        const created = await container()
          .resolve("createWorktree")
          .execute({
            id,
            base: opts.base,
            ports: opts.ports,
            ...(opts.run ? { run: opts.run } : {}),
          });
        return { result: created.map((e) => ({ ...e, variables: portVariables(e) })) };
      }),
    );

  worktree
    .command("setup")
    .description(
      "Make a run's worktree able to run tests: its dependencies (the main checkout's, or an install), and --up its services",
    )
    .option("--worktree <id>", "the worktree (default: the run's)")
    .option("--run <id>", "the run whose worktree to set up (default: the latest run)")
    .option("--up", "also start the worktree's services (metator env up --worktree)", false)
    .action(
      action(async (opts: { worktree?: string; run?: string; up: boolean }) => ({
        result: await container()
          .resolve("setupWorktree")
          .execute({
            ...(opts.worktree ? { worktree: opts.worktree } : {}),
            ...(opts.run ? { run: opts.run } : {}),
            up: opts.up,
          }),
      })),
    );

  meta(worktree.command("conflicts"), { reads: true, writesWith: ["--notify"] })
    .description("Files two active runs changed in their own worktrees, and which to merge first")
    .option("--notify", "tell both runs of each conflict (a shared-file message each way)", false)
    .addOption(byOption("who sends the messages (with --notify)"))
    .action(
      // `--by` is resolved here, not as the option's default: the CLI reference is generated from the options.
      action(async (opts: { notify: boolean; by?: string }) => {
        if (!opts.notify) return { result: await container().resolve("worktreeConflicts").execute({}) };
        return asPerson(container(), opts.by, async (by) => ({
          result: await container().resolve("worktreeConflicts").execute({ notify: { by } }),
        }));
      }),
    );

  meta(worktree.command("list"), { reads: true })
    .description("Worktrees with their branch, ports, run status and whether they hold uncommitted work")
    .action(
      action(async () => {
        const list = await container().resolve("listWorktrees").execute();
        return { result: list.map((worktrees) => ({ worktrees })) };
      }),
    );

  worktree
    .command("rm")
    .description("Remove a worktree and free its ports; uncommitted work needs --force")
    .argument("<id>", "worktree id")
    .option("--force", "remove even with uncommitted changes (they are lost)", false)
    .action(
      action(async (id: string, opts: { force: boolean }) => {
        const c = container();
        // Its services go first: nothing keeps running in a directory that is gone.
        const stopped = await c.resolve("environmentServices").down({ worktree: id });
        const warnings: string[] =
          stopped.isErr() && stopped.error.code !== "NOT_FOUND"
            ? [`services not stopped: ${stopped.error.message}`]
            : [];
        const removed = await c.resolve("removeWorktree").execute({ id, force: opts.force });
        // Its own databases go with it, never before: a refused removal keeps its data.
        const dropped = removed.isOk()
          ? await c.resolve("environmentServices").dropData({ worktree: id })
          : null;
        if (dropped?.isErr() && dropped.error.code !== "NOT_FOUND")
          warnings.push(`data not dropped: ${dropped.error.message}`);
        return {
          result: removed.map((w) => ({
            ...w,
            stoppedServices: stopped.isOk() ? stopped.value : [],
            droppedData: dropped?.isOk() ? dropped.value : [],
          })),
          warnings,
        };
      }),
    );

  worktree
    .command("prune")
    .description("Remove worktrees of finished runs older than N days; never one with uncommitted work")
    .option("--older-than <days>", "minimum age in days", positiveInt, 7)
    .option("--dry-run", "report only", false)
    .action(
      action(async (opts: { olderThan: number; dryRun: boolean }) => {
        const report = await container()
          .resolve("pruneWorktrees")
          .execute({ olderThanDays: opts.olderThan, dryRun: opts.dryRun });
        return {
          result: report,
          warnings: report.isOk()
            ? report.value.keptDirty.map((id) => `${id}: finished but holds uncommitted work; kept`)
            : [],
        };
      }),
    );
}
