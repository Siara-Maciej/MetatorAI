import {
  AnalysisDocument,
  AutonomySchema,
  err,
  MetatorError,
  ok,
  ResearchDocument,
  type Result,
  type RunEvent,
  RunSummaryDocument,
} from "@metator/core";
import { Argument, type Command, Option } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";

export const EVENTS = ["pass", "fail", "approve", "abort"] as const;

/** Artifacts whose format `run schema` prints (plans, findings and verdicts have their own group). */
const RUN_ARTIFACTS = { analysis: AnalysisDocument, research: ResearchDocument, summary: RunSummaryDocument };
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
        return err(MetatorError.usage("approve requires --by <name>", "Gates record who made the decision."));
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

export function registerRunCommands(program: Command, { action, container }: CommandContext): void {
  const runs = program.command("run").description("Start and drive workflow runs (state machine)");

  runs
    .command("init")
    .description("Start a run of a workflow")
    .requiredOption("--workflow <id>", "workflow id")
    .requiredOption("--task <text>", "task description or work item reference")
    .addOption(
      new Option("--autonomy <level>", "L0 all gates, L1 skip plan approval, L2 headless")
        .choices(AutonomySchema.options)
        .default("L0"),
    )
    .option("--worktree", "work in a new git worktree with its own ports (.metator/wt/<run>)", false)
    .option("--base <ref>", "with --worktree: the ref to branch from", "HEAD")
    .action(
      action(
        async (opts: {
          workflow: string;
          task: string;
          autonomy: (typeof AutonomySchema.options)[number];
          worktree: boolean;
          base: string;
        }) => {
          const task = opts.task.trim();
          if (task === "") return { result: err(MetatorError.usage("--task must not be empty")) };
          const input = {
            workflow: opts.workflow,
            task,
            autonomy: opts.autonomy,
            ...(opts.worktree ? { worktree: { base: opts.base } } : {}),
          };
          return { result: await container().resolve("initRun").execute(input) };
        },
      ),
    );

  runs
    .command("advance")
    .description("Send an event to the current stage")
    .addArgument(new Argument("<event>", "event to send").choices(EVENTS))
    .option("--run <id>", "run id (default: latest)")
    .option("--reason <text>", "why (fail, abort)")
    .option("--by <name>", "who decided (required for approve)")
    .option("--choice <value>", "selected option at a gate")
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
    .description("Record a human approval: the HITL stage the run waits at, or an action (push, comment)")
    .argument("<gate>", "current HITL stage id, or push / comment")
    .requiredOption("--by <name>", "who approved")
    .option("--choice <value>", "selected option")
    .option("--run <id>", "run id (default: latest)")
    .action(
      action(async (gate: string, opts: { by: string; choice?: string; run?: string }) => ({
        result: await container()
          .resolve("approveRun")
          .execute({
            gate,
            by: opts.by,
            ...(opts.choice ? { choice: opts.choice } : {}),
            ...(opts.run ? { runId: opts.run } : {}),
          }),
      })),
    );

  runs
    .command("checkpoint")
    .description("Write the run's state summary to log.md (before a context compaction)")
    .option("--run <id>", "run id (default: latest)")
    .action(
      action(async (opts: { run?: string }) => ({
        result: await container()
          .resolve("checkpointRun")
          .execute(opts.run ? { runId: opts.run } : {}),
      })),
    );

  runs
    .command("handoff")
    .description(
      "Write handoff.md from the run directory: stage, approvals, artifacts, recent log, how to resume",
    )
    .option("--run <id>", "run id (default: latest)")
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
    .option("--run <id>", "run id (default: latest)")
    .option("--aborted", "abort an active run first (needs --reason)", false)
    .option("--reason <text>", "why the run is aborted")
    .action(
      action(async (opts: { run?: string; aborted: boolean; reason?: string }) => {
        if (opts.aborted && !opts.reason)
          return { result: err(MetatorError.usage("--aborted needs --reason <text>")) };
        return {
          result: await container()
            .resolve("closeRun")
            .execute({
              ...(opts.run ? { runId: opts.run } : {}),
              ...(opts.aborted && opts.reason ? { abortReason: opts.reason } : {}),
            }),
        };
      }),
    );

  runs
    .command("status")
    .description("Show the current stage, what it expects and recent history")
    .option("--run <id>", "run id (default: latest)")
    .action(
      action(async (opts: { run?: string }) => ({
        result: await container()
          .resolve("getRunStatus")
          .execute(opts.run ? { runId: opts.run } : {}),
      })),
    );

  runs
    .command("schema")
    .description("Print the JSON Schema of a run artifact written by a worker")
    .addArgument(new Argument("<artifact>", "artifact").choices(Object.keys(RUN_ARTIFACTS)))
    .action(
      action(async (artifact: keyof typeof RUN_ARTIFACTS) => ({
        result: ok(RUN_ARTIFACTS[artifact].jsonSchema("input")),
      })),
    );

  runs
    .command("list")
    .description("List runs, newest first")
    .action(action(async () => ({ result: await container().resolve("listRuns").execute() })));
}
