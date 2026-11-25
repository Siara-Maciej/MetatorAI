import {
  err,
  fleetCounts,
  fleetInbox,
  fleetReport,
  MetatorError,
  normalizePath,
  type Overview,
  ok,
  type ReadinessCheck,
  type RepoRuns,
  type RunFacts,
  readinessWarnings,
  unreadableRunWarning,
} from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { callDaemon, liveDaemonAt } from "../daemon-client.ts";
import { type PaneAsk, paneAsks } from "../pane-asks.ts";
import { renderDoctor, renderInbox, renderStatus } from "../render.ts";

type Read = Overview | { error: string };
/** A worktree of a folder's repository in `metator status`, with the label that tells it apart. */
type FolderStatusWorktree = { name: string; path: string; label: string; branch?: string } & Read;
/** A repository of a folder in `metator status`: its own work, and each worktree's under it. */
type FolderStatusRepo = { name: string; path: string; worktrees?: FolderStatusWorktree[] } & Read;

/**
 * `metator status` (G4, ADR-0059): every run (its stages, who must act, the questions, the last
 * thing that happened, its worktree and services) and the conversations; in a folder of
 * repositories, that for each repository.
 */
export function registerStatusCommand(program: Command, ctx: CommandContext): void {
  meta(program.command("status"), { audience: "person", reads: true, folder: true, render: renderStatus })
    .description("The work at a glance: each run's stages, who must act, questions, services; conversations")
    .action(
      ctx.action(async () => {
        const f = ctx.folder();
        if (!f) {
          // The daemon holds the panes: its overview knows which runs an agent works on in one.
          const root = ctx.container().resolve("root");
          const daemon = liveDaemonAt(root);
          const served = daemon
            ? await callDaemon<Overview>(daemon, "GET", "/state", undefined, {}, 5000)
            : undefined;
          const o =
            served?.isOk() && Array.isArray(served.value.runs)
              ? served
              : await ctx.container().resolve("workOverview").execute();
          return { result: o, warnings: o.isOk() ? o.value.unreadable.map(unreadableRunWarning) : [] };
        }
        const warnings: string[] = [];
        // One checkout's overview; its warnings are named with its label (`shop (fix-tax)`).
        const read = async (label: string, root: string): Promise<Read> => {
          try {
            const o = await ctx.containerAt(root).resolve("workOverview").execute();
            if (o.isErr()) {
              warnings.push(`${label}: ${o.error.message}`);
              return { error: o.error.message };
            }
            for (const u of o.value.unreadable) warnings.push(`${label}: ${unreadableRunWarning(u)}`);
            return o.value;
          } catch (e) {
            warnings.push(`${label}: ${(e as Error).message}`);
            return { error: (e as Error).message };
          }
        };
        // By repository: the work of its worktrees under it, each with the label that tells it apart.
        const repos: FolderStatusRepo[] = [];
        const every: object[] = [];
        for (const r of f.repos) {
          const own = await read(r.name, r.root);
          every.push(own);
          const worktrees: FolderStatusWorktree[] = [];
          for (const w of f.checkouts.filter((c) => c.worktreeOf === r.name)) {
            const o = await read(w.label, w.root);
            every.push(o);
            worktrees.push({
              name: w.name,
              path: w.path,
              label: w.label,
              ...(w.branch ? { branch: w.branch } : {}),
              ...o,
            });
          }
          repos.push({ name: r.name, path: r.path, ...own, ...(worktrees.length > 0 ? { worktrees } : {}) });
        }
        const folder = await ctx.containerAt(f.root).resolve("conversationRepository").list();
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
            counts: fleetCounts(every),
          }),
          warnings,
        };
      }),
    );

  meta(program.command("doctor"), {
    audience: "person",
    reads: true,
    writesWith: ["--gates"],
    render: renderDoctor,
  })
    .description(
      "What a run here will and will not do: config, canon, workflows, gates, dependencies, environment, remote",
    )
    .option("--worktree <id>", "look at this worktree (a run's) instead of this checkout")
    .option("--run <id>", "look at this run's worktree")
    .option(
      "--gates",
      "also run the quick gate once and say whether it is green (takes the gate's time; this checkout only)",
      false,
    )
    .action(
      ctx.action(async (opts: { worktree?: string; run?: string; gates: boolean }) => {
        if (opts.run && opts.worktree)
          return {
            result: err(
              MetatorError.usage(
                "--run and --worktree both name the checkout to look at",
                "Pass one: --run <id> looks at that run's worktree.",
              ),
            ),
          };
        let c: ReturnType<typeof ctx.container>;
        try {
          c = ctx.container();
        } catch (e) {
          // A config that does not load is what doctor is for: its failed check, not an error.
          if (!(e instanceof MetatorError) || e.code !== "INVALID_CONFIG") throw e;
          const source = typeof e.details?.source === "string" ? e.details.source : "metator.config.yml";
          const config: ReadinessCheck = {
            id: "config",
            status: "fail",
            message: `${e.message.trim()}; the other checks need a config that loads`,
            fix: e.hint ?? `fix ${source} where the message says`,
          };
          const r = ok({ ready: false, place: ".", checks: [config] });
          return { result: r, warnings: readinessWarnings(r.value) };
        }
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
        const r = await c
          .resolve("checkReadiness")
          .execute({ ...(worktree ? { worktree } : {}), ...(opts.gates ? { gates: true } : {}) });
        return { result: r, warnings: r.isOk() ? readinessWarnings(r.value) : [] };
      }),
    );

  meta(program.command("inbox"), { audience: "person", reads: true, folder: true, render: renderInbox })
    .description(
      "Every open decision of every run, first the ones a live drive waits on, then the oldest; and the escalated runs waiting for a resume",
    )
    .action(
      ctx.action(async () => {
        const f = ctx.folder();
        // Every checkout: a worktree's runs are named with its label (`shop (fix-tax)`).
        const roots = f
          ? f.checkouts.map((r) => ({ name: r.label, root: r.root }))
          : [{ name: "", root: "" }];
        const repos: RepoRuns[] = [];
        const warnings: string[] = [];
        for (const r of roots) {
          const c = r.root ? ctx.containerAt(r.root) : ctx.container();
          const o = await c.resolve("workOverview").execute();
          if (o.isErr()) {
            if (!f) return { result: o };
            warnings.push(`${r.name}: ${o.error.message}`);
            continue;
          }
          for (const u of o.value.unreadable)
            warnings.push(f ? `${r.name}: ${unreadableRunWarning(u)}` : unreadableRunWarning(u));
          repos.push({ name: r.name, runs: o.value.runs, now: c.resolve("clock").now() });
        }
        // One queue across repositories, in the same order as within one; then the questions of
        // panes, which only the daemon that owns the panes knows (ADR-0091).
        const panes: PaneAsk[] = await paneAsks(ctx.start());
        return { result: ok({ ...fleetInbox(repos, f !== null), panes }), warnings };
      }),
    );

  meta(program.command("report"), { audience: "person", reads: true, writesWith: ["--html"], folder: true })
    .description(
      "What the runs cost and asked of people: tokens, money, agent time, questions, waiting, per agent",
    )
    .option("--since <time>", "only runs started at or after this ISO time")
    .option(
      "--html <file>",
      "also write the dashboard: the report and the reactions to review comments as one page",
    )
    .action(
      ctx.action(async (opts: { since?: string; html?: string }) => {
        if (opts.since && Number.isNaN(Date.parse(opts.since)))
          return { result: err(MetatorError.usage(`--since ${opts.since}: expected an ISO time`)) };
        const since = opts.since ? new Date(opts.since).toISOString() : undefined;
        const f = ctx.folder();
        if (opts.html) {
          if (f)
            return {
              result: err(MetatorError.usage("--html renders one repository: run it inside the repository")),
            };
          return {
            result: await ctx
              .container()
              .resolve("renderReport")
              .execute({ out: normalizePath(opts.html), ...(since ? { since } : {}) }),
          };
        }
        if (!f) {
          const report = await ctx.container().resolve("buildReport").execute(since);
          if (report.isErr()) return { result: report };
          const reactions = await ctx.container().resolve("reviewFeedback").stats();
          return { result: reactions.map((r) => ({ ...report.value, reactions: r })) };
        }
        // A folder: every repository's runs in one report, each run named with its repository.
        const facts: RunFacts[] = [];
        const warnings: string[] = [];
        for (const r of f.checkouts) {
          const got = await ctx.containerAt(r.root).resolve("buildReport").facts(since);
          if (got.isErr()) warnings.push(`${r.name}: ${got.error.message}`);
          else facts.push(...got.value.map((x) => ({ ...x, runId: `${r.name}/${x.runId}` })));
        }
        return { result: ok(fleetReport(facts, ctx.container().resolve("clock").now())), warnings };
      }),
    );
}
