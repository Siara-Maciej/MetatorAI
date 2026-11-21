import {
  err,
  MetatorError,
  normalizePath,
  ok,
  type QuickFitOutcome,
  type QuickReadyOutcome,
  type Result,
} from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { positiveInt, runOption } from "../options.ts";
import { paneStartedRun } from "./guard.ts";

/** `--files a,b` (or repeated): repository-relative paths. */
const filesOf = (value: string, all: string[]): string[] => [
  ...all,
  ...value
    .split(",")
    .map((f) => normalizePath(f.trim()))
    .filter((f) => f !== ""),
];

/** How long `--wait` waits for the person before it says "not yet" (a host's command has a time limit). */
const WAIT_MS = 9 * 60_000;

/**
 * `quick` (ADR-0093): the way for a small change without a plan. `check` says whether a change is
 * small enough (no model is asked), `start` starts it as an `mt-quick` run, `fit` and `ready` are
 * that run's two gates: each asks the person on a card and says "not yet" (exit 4) until they answer.
 */
export function registerQuickCommands(program: Command, ctx: CommandContext): void {
  const { action, container, runs } = ctx;
  const quick = program
    .command("quick")
    .description(
      "A small change without a plan: is it small enough (check), start it (start), and its run's two gates (fit, ready)",
    );

  meta(quick.command("check"), { reads: true })
    .description(
      "Is this change small enough for quick? Decided from the files, the diff and the task's words; lists every escalator with why and the tool that saw it",
    )
    .option("--files <a,b>", "the files the change is expected to touch (before it starts)", filesOf, [])
    .option("--diff", "the working tree's uncommitted changes (after the build)", false)
    .option("--task <text>", "the task in the person's words: the files it names and what its words say")
    .action(
      action(async (opts: { files: string[]; diff: boolean; task?: string }) => ({
        result: await container()
          .resolve("quickCheck")
          .execute({
            ...(opts.files.length > 0 ? { files: opts.files } : {}),
            ...(opts.diff ? { diff: true } : {}),
            ...(opts.task !== undefined ? { task: opts.task } : {}),
          }),
      })),
    );

  meta(quick.command("start"), { audience: "person" })
    .description(
      "Start a small change as an mt-quick run (build, gate, one short review; it ends with an uncommitted diff). Refused while an escalator trips, unless the person keeps it quick in one sentence",
    )
    .requiredOption("--task <text>", "the task, in the person's words")
    .option("--files <a,b>", "the files the change is expected to touch", filesOf, [])
    .option(
      "--override <sentence>",
      "the person's own sentence that keeps it quick although escalators tripped (recorded with the run; never lifts cross-repository)",
    )
    .option(
      "--here",
      "the checkout has uncommitted changes: work in it (they become part of the change)",
      false,
    )
    .option("--worktree", "work in a worktree of its own, from the last commit", false)
    .option("--host <host>", "the interactive host of its conductor session (default: supervisor.hostOrder)")
    .action(
      action(
        async (opts: {
          task: string;
          files: string[];
          override?: string;
          here: boolean;
          worktree: boolean;
          host?: string;
        }) => {
          const task = opts.task.trim();
          if (task === "") return { result: err(MetatorError.usage("--task must not be empty")) };
          if (opts.here && opts.worktree)
            return { result: err(MetatorError.usage("--here or --worktree, not both")) };
          const c = container();
          const check = await c.resolve("quickCheck").execute({
            task,
            ...(opts.files.length > 0 ? { files: opts.files } : {}),
          });
          if (check.isErr()) return { result: check };
          const started = await c.resolve("quickStart").execute({
            task,
            check: check.value,
            ...(opts.override !== undefined ? { override: opts.override } : {}),
            ...(opts.here ? { where: "here" as const } : opts.worktree ? { where: "worktree" as const } : {}),
            ...(opts.host ? { host: opts.host } : {}),
          });
          if (started.isErr()) return { result: started };
          const { runId, started: run, overridden } = started.value;
          // Started from a pane (the chat where the person gave the task): it is this run's main terminal.
          await paneStartedRun(runId, process.env, c.resolve("root"));
          return {
            result: ok({
              runId,
              workflow: "mt-quick",
              stage: run.run.stage,
              ...(run.run.worktree ? { worktree: run.run.worktree } : {}),
              ...(run.session ? { session: run.session } : {}),
              ...(run.noSession ? { noSession: run.noSession } : {}),
              ...(run.drive ? { drive: run.drive } : {}),
              ...(overridden ? { overridden } : {}),
              check: { quick: check.value.quick, escalators: check.value.escalators },
            }),
            warnings: run.warnings,
          };
        },
      ),
    );

  /** A gate that asks the person: with `--wait` it looks again until they answered, or the wait is over. */
  const waiting = async <O extends { readonly state: string }>(
    runId: string,
    wait: number | undefined,
    look: () => Promise<Result<O, MetatorError>>,
  ): Promise<Result<O, MetatorError>> => {
    const timer = runs().resolve("timer");
    const repo = runs().resolve("runRepository");
    const stage = (await repo.load(runId)).map((r) => r.state.stage);
    for (let waited = 0; ; waited += 500) {
      const seen = await look();
      if (seen.isErr() || seen.value.state !== "waiting" || wait === undefined || waited >= wait) return seen;
      // The run left the stage or ended meanwhile (an abort, a person in another terminal).
      const now = await repo.load(runId);
      if (now.isErr()) return err(now.error);
      if (now.value.state.status !== "active" || (stage.isOk() && now.value.state.stage !== stage.value))
        return seen;
      await timer.sleep(500);
    }
  };
  const notYet = (prompt: string, question: string, runId: string, details: Record<string, unknown>) =>
    new MetatorError("WAITING", `waiting for the person: "${prompt}" (${question})`, {
      hint: `They answer in the inbox or with \`metator run answer ${question} --run ${runId} --choice <label>\`. Run this gate again with --wait: it returns when they answered.`,
      details: { question, ...details },
    });
  const waitOption = [
    "--wait [ms]",
    "wait for the person's answer (at most this long, default 9 minutes), instead of saying not yet at once",
  ] as const;
  const waitOf = (wait: number | true | undefined): number | undefined => (wait === true ? WAIT_MS : wait);

  quick
    .command("fit")
    .description(
      "The gate after a quick run's build: the real diff against the limits. Past them it asks the person (continue as full, or keep as quick): not yet (exit 4) until they answer",
    )
    .addOption(runOption())
    .option(...waitOption, positiveInt)
    .action(
      action(async (opts: { run?: string; wait?: number | true }) => {
        const id = await runs().resolve("runRepository").resolveId(opts.run);
        if (id.isErr()) return { result: id };
        const runId = id.value;
        // The diff is read where the command runs (the run's worktree, or the checkout).
        const verdict = await container().resolve("quickCheck").execute({ diff: true });
        if (verdict.isErr()) return { result: verdict };
        const seen = await waiting<QuickFitOutcome>(runId, waitOf(opts.wait), () =>
          runs().resolve("quickFit").execute({ runId, verdict: verdict.value }),
        );
        if (seen.isErr()) return { result: seen };
        const out = seen.value;
        if (out.state === "waiting")
          return {
            result: err(
              notYet(
                `This grew past quick: ${out.escalators.map((e) => `${e.id} (${e.why})`).join("; ")}`,
                out.question,
                runId,
                { escalators: out.escalators },
              ),
            ),
          };
        if (out.state === "full")
          return {
            result: ok({
              runId,
              ...out,
              next: `Quick run ${runId} is closed: run ${out.run} (${out.workflow}) continues the change in its own conductor session. Do nothing more for ${runId}.`,
            }),
          };
        return { result: ok({ runId, ...out, files: verdict.value.files }) };
      }),
    );

  quick
    .command("ready")
    .description(
      "The gate that ends a quick run: asks the person to look at the diff. Not yet (exit 4) until they say Fine, which ends the run; nothing is committed",
    )
    .addOption(runOption())
    .option(...waitOption, positiveInt)
    .action(
      action(async (opts: { run?: string; wait?: number | true }) => {
        const id = await runs().resolve("runRepository").resolveId(opts.run);
        if (id.isErr()) return { result: id };
        const runId = id.value;
        const seen = await waiting<QuickReadyOutcome>(runId, waitOf(opts.wait), () =>
          runs().resolve("quickReady").execute({ runId }),
        );
        if (seen.isErr()) return { result: seen };
        if (seen.value.state === "waiting")
          return {
            result: err(notYet("Quick change ready: look at the diff", seen.value.question, runId, {})),
          };
        return {
          result: ok({
            runId,
            ...seen.value,
            ...(seen.value.run === "done" ? { next: `Run ${runId} is done: do not advance it.` } : {}),
          }),
        };
      }),
    );
}
