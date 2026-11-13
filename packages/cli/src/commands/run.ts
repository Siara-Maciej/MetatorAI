import {
  AnalysisDocument,
  AutonomySchema,
  countAttention,
  err,
  FindingSetDocument,
  INPUT_NAME,
  MESSAGE_TOPICS,
  type MessageTopic,
  MetatorError,
  ok,
  PlanDocument,
  PlanScopeDocument,
  ResearchDocument,
  type Result,
  ReviewMetadataDocument,
  ReviewPlanDocument,
  RUN_READINESS,
  type RunEvent,
  RunSummaryDocument,
  readinessWarnings,
  taskWarnings,
  unreadableRunWarning,
  VerdictDocument,
} from "@metator/core";
import { Argument, type Command, Option } from "commander";
import { meta, renamedCommand } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { callDaemon, findDaemon } from "../daemon-client.ts";
import { byOption, defined, positiveInt, RUN_ARGUMENT, runGiven, runOption } from "../options.ts";
import { renderRunStatus } from "../render.ts";
import { HOSTS, resume } from "../sessions.ts";
import { asPerson, who } from "../who.ts";
import { registerConductorCommands } from "./conductor.ts";
import { registerDriveCommands } from "./drive.ts";

export const EVENTS = ["pass", "fail", "approve", "abort"] as const;

/** The JSON artifacts a stage produces, by the name its `produces` gives them: `run schema` prints each. */
const RUN_ARTIFACTS = {
  analysis: AnalysisDocument,
  research: ResearchDocument,
  plan: PlanDocument,
  "plan-scope": PlanScopeDocument,
  "review-plan": ReviewPlanDocument,
  pr: ReviewMetadataDocument,
  findings: FindingSetDocument,
  verdict: VerdictDocument,
  summary: RunSummaryDocument,
};
type EventName = (typeof EVENTS)[number];

interface AdvanceOptions {
  readonly run?: string;
  readonly reason?: string;
  readonly by?: string;
  readonly choice?: string;
}

/** Commander validates the event name (choices); this adds the per-event required fields. */
export function toEvent(name: EventName, opts: AdvanceOptions): Result<RunEvent, MetatorError> {
  switch (name) {
    case "pass":
      return ok({ type: "PASS" });
    case "fail":
      return ok(opts.reason ? { type: "FAIL", reason: opts.reason } : { type: "FAIL" });
    case "approve":
      if (!opts.by?.trim()) {
        return err(MetatorError.usage("approve requires --by <name>", "An approval records who gave it."));
      }
      return ok(
        opts.choice
          ? { type: "APPROVE", by: opts.by, choice: opts.choice }
          : { type: "APPROVE", by: opts.by },
      );
    case "abort":
      if (!opts.reason?.trim()) return err(MetatorError.usage("abort requires --reason <text>"));
      return ok({ type: "ABORT", reason: opts.reason });
  }
}

export function registerRunCommands(program: Command, ctx: CommandContext): void {
  const { action, stdin } = ctx;
  // In a worktree, the run is the one of the checkout it came from.
  const container = ctx.runs;
  const root = ctx.start;
  const runs = meta(program.command("run"), { audience: "person" }).description(
    "Start and drive workflow runs (state machine)",
  );

  // `run new`, as a worktree and a plan are made (`worktree new`); `run init` is its old name.
  renamedCommand({ parent: runs, name: "init" }, { parent: runs, name: "new" }, (cmd) =>
    meta(cmd, { audience: "person" })
      .description("Start a run of a workflow")
      .requiredOption("--workflow <id>", "workflow id")
      .requiredOption("--task <text>", "task description or work item reference")
      .addOption(
        new Option(
          "--autonomy <level>",
          "L0 every approval waits for you, L1 skips the approvals the workflow lets it skip, L2 no person at hand; one the workflow lists (default: L0 when it lists it)",
        ).choices(AutonomySchema.options),
      )
      .option("--worktree", "work in a new git worktree with its own ports (.metator/wt/<run>)", false)
      .option("--base <ref>", "with --worktree: the ref to branch from", "HEAD")
      .option(
        "--no-setup",
        "with --worktree: leave the worktree without its dependencies (metator worktree setup later)",
      )
      .option(
        "--allow-dirty",
        "start although tracked files have uncommitted changes (with --worktree the run starts from the last commit, without them; in this checkout they become part of its change)",
        false,
      )
      .option(
        "--parent <run>",
        "the run this one is a child of (a system run, possibly in another repository)",
      )
      .option(
        "--input <name=value>",
        "a workflow input its scripts read as {name} (repeatable), e.g. base=main",
        (v: string, all: string[]) => [...all, v],
        [] as string[],
      )
      .action(
        action(
          async (opts: {
            workflow: string;
            task: string;
            autonomy?: (typeof AutonomySchema.options)[number];
            worktree: boolean;
            base: string;
            setup: boolean;
            allowDirty: boolean;
            parent?: string;
            input: string[];
          }) => {
            const task = opts.task.trim();
            if (task === "") return { result: err(MetatorError.usage("--task must not be empty")) };
            const inputs: Record<string, string> = {};
            for (const pair of opts.input) {
              const at = pair.indexOf("=");
              const name = pair.slice(0, at);
              if (at <= 0 || !INPUT_NAME.test(name) || at === pair.length - 1)
                return {
                  result: err(MetatorError.usage(`--input ${pair}: expected <name>=<value>, e.g. base=main`)),
                };
              inputs[name] = pair.slice(at + 1);
            }
            const input = {
              ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
              workflow: opts.workflow,
              task,
              ...(opts.autonomy ? { autonomy: opts.autonomy } : {}),
              ...(opts.worktree
                ? { worktree: { base: opts.base, ...(opts.allowDirty ? { allowDirty: true } : {}) } }
                : opts.allowDirty
                  ? { allowDirty: true }
                  : {}),
              ...(opts.parent ? { parent: opts.parent } : {}),
            };
            const started = await container().resolve("initRun").execute(input);
            if (started.isErr()) return { result: started };
            // A worktree gets its dependencies now, so the run's tests and gates can run there.
            const setup =
              opts.worktree && opts.setup
                ? await container().resolve("setupWorktree").execute({ run: started.value.runId })
                : undefined;
            // What this run will not do here (no dependencies, no gates), said once, as it starts.
            const ready = await container()
              .resolve("checkReadiness")
              .execute(started.value.worktree ? { worktree: started.value.worktree.id } : {});
            // The attention budget (SupervisorPolicy.wipLimit): too many runs already wait for a person.
            const overview = await container().resolve("workOverview").execute();
            const limit = container().resolve("config").config.supervisor.wipLimit;
            const waiting = overview.isOk() ? countAttention(overview.value.runs).you : 0;
            return {
              result: ok({
                ...started.value,
                ...(setup?.isOk() ? { setup: setup.value } : {}),
              }),
              warnings: [
                ...(waiting >= limit
                  ? [
                      `attention: ${waiting} run(s) already wait for a person (limit ${limit}): answer them first (metator inbox), or raise supervisor.wipLimit`,
                    ]
                  : []),
                ...taskWarnings(task),
                ...(setup?.isErr() ? [`worktree setup: ${setup.error.message}`] : []),
                ...(ready.isOk() ? readinessWarnings(ready.value, RUN_READINESS) : []),
              ],
            };
          },
        ),
      ),
  );

  runs
    .command("advance")
    .description("Send an event to the current stage")
    .addArgument(new Argument("<event>", "event to send").choices(EVENTS))
    .addOption(runOption())
    .option("--reason <text>", "why (fail, abort)")
    .addOption(byOption("who decided (required for approve)", "explicit"))
    .option("--choice <value>", "selected option at an approval")
    .action(
      action(async (name: EventName, opts: AdvanceOptions) => {
        const event = toEvent(name, opts);
        if (event.isErr()) return { result: err(event.error) };
        const input = opts.run ? { runId: opts.run, event: event.value } : { event: event.value };
        return { result: await container().resolve("advanceRun").execute(input) };
      }),
    );

  runs
    .command("approve")
    .description(
      "Record a person's approval: the approval stage the run waits at, or an action (push, comment)",
    )
    .argument("<gate>", "the approval stage the run waits at, or push / comment")
    .addOption(byOption("who approved", "required"))
    .option("--choice <value>", "selected option")
    .addOption(runOption())
    .addOption(
      new Option(
        "--via <channel>",
        "chat: the person said yes in the session's chat; counts only while they are attached",
      ).choices(["chat"]),
    )
    .action(
      action(async (gate: string, opts: { by: string; choice?: string; run?: string; via?: "chat" }) => ({
        result: await container()
          .resolve("approveRun")
          .execute({
            gate,
            by: opts.by,
            ...(opts.choice ? { choice: opts.choice } : {}),
            ...(opts.run ? { runId: opts.run } : {}),
            ...(opts.via ? { via: opts.via } : {}),
          }),
      })),
    );

  // `run take`: the lock, not a terminal (`metator attach <pane>` is the terminal); `run attach` is its old name.
  renamedCommand({ parent: runs, name: "attach" }, { parent: runs, name: "take" }, (cmd) =>
    cmd
      .description("Take the session's keyboard: your input goes to its PTY and your yes in the chat counts")
      .addOption(byOption("who takes it"))
      .addOption(runOption())
      .action(
        action(async (opts: { by?: string; run?: string }) =>
          asPerson(container(), opts.by, async (by) => ({
            result: await container()
              .resolve("driverLock")
              .attach({ by, ...defined({ runId: opts.run }) }),
          })),
        ),
      ),
  );

  runs
    .command("release")
    .description("Give the session back to the agent")
    .addOption(runOption())
    .action(
      action(async (opts: { run?: string }) => ({
        result: await container()
          .resolve("driverLock")
          .release(opts.run ? { runId: opts.run } : {}),
      })),
    );

  runs
    .command("message")
    .description("Send another run a message (data for its agents, never instructions)")
    .argument("<to>", "the receiving run id")
    .requiredOption("--from <run>", "the sending run id")
    .addOption(new Option("--topic <topic>", "what it is about").choices([...MESSAGE_TOPICS]).default("info"))
    .requiredOption("--text <text>", "the message")
    .option(
      "--ref <ref>",
      "a file, run or URL it points at (repeatable)",
      (v: string, all: string[]) => [...all, v],
      [] as string[],
    )
    .addOption(byOption("who sends: an agent of the run, or a person"))
    .action(
      action(
        async (
          to: string,
          opts: {
            from: string;
            topic: MessageTopic;
            text: string;
            ref: string[];
            by?: string;
          },
        ) =>
          asPerson(container(), opts.by, async (by) => ({
            result: await container()
              .resolve("runMessages")
              .send({ from: opts.from, to, topic: opts.topic, text: opts.text, refs: opts.ref, by }),
          })),
      ),
    );

  meta(runs.command("messages"), { reads: true })
    .description("Messages other runs sent this run")
    .addOption(runOption())
    .action(
      action(async (opts: { run?: string }) => {
        const c = container();
        const id = await c.resolve("runRepository").resolveId(opts.run);
        if (id.isErr()) return { result: id };
        return {
          result: (await c.resolve("runMessages").list(id.value)).map((messages) => ({
            runId: id.value,
            messages,
          })),
        };
      }),
    );

  runs
    .command("checkpoint")
    .description("Write the run's state summary to log.md (before a context compaction)")
    .addOption(runOption())
    .action(
      action(async (opts: { run?: string }) => ({
        result: await container()
          .resolve("checkpointRun")
          .execute(opts.run ? { runId: opts.run } : {}),
      })),
    );

  runs
    .command("resume")
    .description(
      "Resume an escalated run at the stage it escalated from, once the cause is fixed; --drive carries it on at once",
    )
    .addOption(byOption("who resumes it, recorded in log.md"))
    .addOption(runOption())
    .option("--drive", "also start a drive in the background, as `run continue` does", false)
    .option("--host <host>", `with --drive: the AI host (${HOSTS.join(", ")}; default: the one the run used)`)
    .action(
      action(async (opts: { by?: string; run?: string; drive: boolean; host?: string }) => {
        const c = container();
        const by = await who(c, opts.by);
        if (by.isErr()) return { result: by };
        const resumed = await c
          .resolve("resumeRun")
          .execute({ by: by.value, ...(opts.run ? { runId: opts.run } : {}) });
        if (resumed.isErr() || !opts.drive) return { result: resumed };
        const driven = await resume(c, root(), resumed.value.runId, opts.host);
        if (driven.isErr())
          return {
            result: resumed,
            warnings: [
              `the run is resumed, but no drive started: ${driven.error.message}${driven.error.hint ? ` (${driven.error.hint})` : ""}; start one with \`metator run continue ${resumed.value.runId}\``,
            ],
          };
        const driver = await c.resolve("runDrivers").status(resumed.value.runId);
        return { result: ok({ ...resumed.value, drive: driver.isOk() ? driver.value : null }) };
      }),
    );

  runs
    .command("write")
    .description("Write an artifact the current stage produces (intake: task.md) from stdin into the run")
    .argument("<artifact>", "the artifact's name, as the stage's `produces` lists it")
    .addOption(runOption())
    .action(
      action(async (artifact: string, opts: { run?: string }) => ({
        result: await container()
          .resolve("writeRunArtifact")
          .execute({ artifact, content: await stdin(), ...(opts.run ? { runId: opts.run } : {}) }),
      })),
    );

  runs
    .command("handoff")
    .description(
      "Write handoff.md from the run directory: stage, approvals, artifacts, recent log, how to resume",
    )
    .addOption(runOption())
    .option("--log-lines <n>", "recent log entries to include", positiveInt, 10)
    .action(
      action(async (opts: { run?: string; logLines: number }) => ({
        result: await container()
          .resolve("handoffRun")
          .execute({ logLines: opts.logLines, ...(opts.run ? { runId: opts.run } : {}) }),
      })),
    );

  runs
    .command("close")
    .description(
      "Write summary.json (final telemetry) for a finished run; --aborted --reason aborts an active one",
    )
    .addOption(runOption())
    .option("--aborted", "abort an active run first (needs --reason)", false)
    .option("--reason <text>", "why the run is aborted")
    .option("--remove-worktree", "remove the run's worktree too (its ports are freed)", false)
    .option("--force", "remove the worktree even with uncommitted changes", false)
    .argument(...RUN_ARGUMENT)
    .action(
      action(
        async (
          word: string | undefined,
          opts: {
            run?: string;
            aborted: boolean;
            reason?: string;
            removeWorktree: boolean;
            force: boolean;
          },
        ) => {
          const run = runGiven(word, opts);
          if (run.isErr()) return { result: run };
          if (opts.aborted && !opts.reason)
            return { result: err(MetatorError.usage("--aborted needs --reason <text>")) };
          const closed = await container()
            .resolve("closeRun")
            .execute({
              ...defined({ runId: run.value }),
              ...(opts.aborted && opts.reason ? { abortReason: opts.reason } : {}),
            });
          if (closed.isErr()) return { result: closed };
          // The run's panes go with it (R5), when a daemon holds them; its worktree only when asked.
          const runId = closed.value.runId;
          const daemon = findDaemon(root());
          const panes = daemon.isOk()
            ? await callDaemon<{ closed: number }>(
                daemon.value,
                "POST",
                `/runs/${encodeURIComponent(runId)}/close-panes`,
                {},
              )
            : undefined;
          const record = await container().resolve("runRepository").load(runId);
          let worktree: { id: string; path: string; removed: boolean } | undefined;
          if (opts.removeWorktree && record.isOk() && record.value.worktree) {
            const removed = await container()
              .resolve("removeWorktree")
              .execute({ id: record.value.worktree.id, force: opts.force });
            if (removed.isErr()) return { result: removed };
            worktree = { id: removed.value.id, path: removed.value.path, removed: true };
          }
          return {
            result: ok({
              ...closed.value,
              ...(panes?.isOk() ? { panes: panes.value } : {}),
              ...(worktree ? { worktree } : {}),
            }),
          };
        },
      ),
    );

  meta(runs.command("status"), { audience: "person", reads: true, render: renderRunStatus })
    .description("Show the current stage, what it expects and recent history")
    .argument(...RUN_ARGUMENT)
    .addOption(runOption())
    .action(
      action(async (word: string | undefined, opts: { run?: string }) => {
        const run = runGiven(word, opts);
        if (run.isErr()) return { result: run };
        return {
          result: await container()
            .resolve("getRunStatus")
            .execute(defined({ runId: run.value })),
        };
      }),
    );

  runs
    .command("board")
    .description(
      "The plan board (S2): stages with who worked them, the plan's steps with their state, workers, what waits for you, artifacts, gates, the last events",
    )
    .addOption(runOption())
    .option("--timeline <n>", "how many events to keep", positiveInt, 30)
    .argument(...RUN_ARGUMENT)
    .action(
      action(async (word: string | undefined, opts: { run?: string; timeline: number }) => {
        const run = runGiven(word, opts);
        if (run.isErr()) return { result: run };
        return {
          result: await container()
            .resolve("planBoard")
            .execute({ ...defined({ runId: run.value }), timeline: opts.timeline }),
        };
      }),
    );

  meta(runs.command("published"), { reads: true })
    .description(
      "Whether the run's work is published: nothing uncommitted, and origin's branch at the checked-out commit (the publish gate)",
    )
    .action(
      // The branch checked out here (a run's worktree), not the checkout its runs live in.
      action(async () => ({
        result: await ctx.container().resolve("checkPublished").execute(),
      })),
    );

  runs
    .command("schema")
    .description("Print the JSON Schema of a run artifact written by a worker")
    // `analysis.json`, as a stage's `produces` names it, is the same artifact as `analysis`.
    .argument("<artifact>", `artifact: ${Object.keys(RUN_ARTIFACTS).join(", ")} (with or without .json)`)
    .action(
      action(async (artifact: string) => {
        const name = artifact.replace(/\.json$/, "");
        return {
          result:
            name in RUN_ARTIFACTS
              ? ok(RUN_ARTIFACTS[name as keyof typeof RUN_ARTIFACTS].jsonSchema("input"))
              : err(
                  MetatorError.usage(
                    `no schema for ${artifact}`,
                    `Artifacts with a schema: ${Object.keys(RUN_ARTIFACTS).join(", ")}.`,
                  ),
                ),
        };
      }),
    );

  meta(runs.command("list"), { reads: true })
    .description("List runs, newest first")
    .action(
      action(async () => {
        const listed = await container().resolve("listRuns").execute();
        return {
          result: listed.map((l) => l.runs),
          warnings: listed.isOk() ? listed.value.unreadable.map(unreadableRunWarning) : [],
        };
      }),
    );
  registerDriveCommands(program, runs, ctx);
  registerConductorCommands(program, runs, ctx);
}
