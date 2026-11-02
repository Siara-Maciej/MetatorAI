import {
  byUrgency,
  err,
  fleetReport,
  type InboxItem,
  inboxOf,
  MetatorError,
  type Overview,
  ok,
  type RunFacts,
  readinessWarnings,
} from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

/**
 * `metator status` (G4, ADR-0059): every run (its stages, who must act, the questions, the last
 * thing that happened, its worktree and services) and the conversations; in a folder of
 * repositories, that for each repository.
 */
export function registerStatusCommand(program: Command, ctx: CommandContext): void {
  program
    .command("status")
    .description("The work at a glance: each run's stages, who must act, questions, services; conversations")
    .action(
      ctx.action(async () => {
        const f = ctx.folder();
        if (!f) return { result: await ctx.container().resolve("workOverview").execute() };
        const repos: ({ name: string; path: string } & (Overview | { error: string }))[] = [];
        const warnings: string[] = [];
        for (const r of f.repos) {
          try {
            const o = await ctx.containerAt(r.root).resolve("workOverview").execute();
            if (o.isErr()) {
              warnings.push(`${r.name}: ${o.error.message}`);
              repos.push({ name: r.name, path: r.path, error: o.error.message });
            } else repos.push({ name: r.name, path: r.path, ...o.value });
          } catch (e) {
            warnings.push(`${r.name}: ${(e as Error).message}`);
            repos.push({ name: r.name, path: r.path, error: (e as Error).message });
          }
        }
        const folder = await ctx.containerAt(f.root).resolve("conversationRepository").list();
        const sum = (k: "you" | "driving" | "stopped" | "questions" | "services") =>
          repos.reduce((n, r) => n + ("counts" in r ? r.counts[k] : 0), 0);
        return {
          result: ok({
            folder: f.root,
            repos,
            conversations: folder.isOk()
              ? folder.value.map((c) => ({
                  id: c.id,
                  title: c.title,
                  host: c.host,
                  turns: c.turns.length,
                  updatedAt: c.updatedAt,
                }))
              : [],
            counts: {
              you: sum("you"),
              driving: sum("driving"),
              stopped: sum("stopped"),
              questions: sum("questions"),
              services: sum("services"),
            },
          }),
          warnings,
        };
      }),
    );

  program
    .command("doctor")
    .description(
      "What a run here will and will not do: config, canon, workflows, gates, dependencies, environment, remote",
    )
    .option("--worktree <id>", "look at this worktree (a run's session) instead of this checkout")
    .option("--run <id>", "look at this run's worktree")
    .action(
      ctx.action(async (opts: { worktree?: string; run?: string }) => {
        const c = ctx.container();
        let worktree = opts.worktree;
        if (opts.run) {
          const record = await c.resolve("runRepository").load(opts.run);
          if (record.isErr()) return { result: record };
          if (!record.value.worktree)
            return {
              result: err(MetatorError.usage(`run ${opts.run} works in this checkout, not in a worktree`)),
            };
          worktree = record.value.worktree.id;
        }
        const r = await c.resolve("checkReadiness").execute(worktree ? { worktree } : {});
        return { result: r, warnings: r.isOk() ? readinessWarnings(r.value) : [] };
      }),
    );

  program
    .command("inbox")
    .description("Every open decision of every run, first the ones a live drive waits on, then the oldest")
    .action(
      ctx.action(async () => {
        const f = ctx.folder();
        const roots = f ? f.repos.map((r) => ({ name: r.name, root: r.root })) : [{ name: "", root: "" }];
        const items: (InboxItem & { repo?: string })[] = [];
        const warnings: string[] = [];
        for (const r of roots) {
          const c = r.root ? ctx.containerAt(r.root) : ctx.container();
          const o = await c.resolve("workOverview").execute();
          if (o.isErr()) {
            if (!f) return { result: o };
            warnings.push(`${r.name}: ${o.error.message}`);
            continue;
          }
          const now = c.resolve("clock").now();
          for (const item of inboxOf(o.value.runs, now)) items.push(f ? { repo: r.name, ...item } : item);
        }
        // One queue across repositories, in the same order as within one.
        return { result: ok({ decisions: items.sort(byUrgency) }), warnings };
      }),
    );

  program
    .command("report")
    .description(
      "What the runs cost and asked of people: tokens, money, agent time, questions, waiting, per agent",
    )
    .option("--since <time>", "only runs started at or after this ISO time")
    .action(
      ctx.action(async (opts: { since?: string }) => {
        if (opts.since && Number.isNaN(Date.parse(opts.since)))
          return { result: err(MetatorError.usage(`--since ${opts.since}: expected an ISO time`)) };
        const since = opts.since ? new Date(opts.since).toISOString() : undefined;
        const f = ctx.folder();
        if (!f) return { result: await ctx.container().resolve("buildReport").execute(since) };
        // A folder: every repository's runs in one report, each run named with its repository.
        const facts: RunFacts[] = [];
        const warnings: string[] = [];
        for (const r of f.repos) {
          const got = await ctx.containerAt(r.root).resolve("buildReport").facts(since);
          if (got.isErr()) warnings.push(`${r.name}: ${got.error.message}`);
          else facts.push(...got.value.map((x) => ({ ...x, runId: `${r.name}/${x.runId}` })));
        }
        return { result: ok(fleetReport(facts, ctx.container().resolve("clock").now())), warnings };
      }),
    );
}
