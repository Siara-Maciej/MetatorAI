import type { WaitOutcome, WorkerResult } from "@metator/core";
import { type Command, Option } from "commander";
import type { CommandContext } from "../context.ts";
import { callDaemon, findDaemon, paneHeaders } from "../daemon-client.ts";
import { positiveInt } from "../options.ts";

/**
 * `metator run start|delegate|wait|collect|workers|result` (R2, ADR-0080): the conductor's
 * commands go through the daemon, which owns the panes and checks who calls (the pane token);
 * a worker's report is a file in the run directory, written here, so a worker needs no daemon.
 */
export function registerConductorCommands(program: Command, runs: Command, ctx: CommandContext): void {
  const root = () => (program.opts() as { root?: string }).root ?? process.cwd();
  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown) => {
    const daemon = findDaemon(root());
    if (daemon.isErr()) return daemon;
    return callDaemon<T>(daemon.value, method, path, body, paneHeaders());
  };
  const runPath = async (run: string | undefined, rest: string) => {
    const id = await ctx.runs().resolve("runRepository").resolveId(run);
    return id.map((runId) => `/runs/${encodeURIComponent(runId)}/${rest}`);
  };

  runs
    .command("start")
    .description("Open the run as a conductor pane: an interactive host session that runs the workflow")
    .option("--run <id>", "run id (default: latest)")
    .option(
      "--host <id>",
      "an interactive host: copilot, claude, opencode (default: the run's host, else the first of supervisor.hostOrder that is installed)",
    )
    .action(
      ctx.action(async (opts: { run?: string; host?: string }) => {
        const path = await runPath(opts.run, "start");
        if (path.isErr()) return { result: path };
        return { result: await call("POST", path.value, opts.host ? { host: opts.host } : {}) };
      }),
    );

  runs
    .command("delegate <stage>")
    .description(
      "A worker pane for the current stage: one of the stage's agents, with its card as its whole task",
    )
    .requiredOption("--agent <id>", "the worker's agent (one the stage lists)")
    .option("--card <text>", "the card: goal, inputs, output, size of the summary")
    .option("--card-file <path>", "the card from a file")
    .option("--name <name>", "the worker's name (default: <agent>-<n>)")
    .option("--host <id>", "the worker's host (default: the run's)")
    .option("--run <id>", "run id (default: latest)")
    .action(
      ctx.action(
        async (
          stage: string,
          opts: {
            agent: string;
            card?: string;
            cardFile?: string;
            name?: string;
            host?: string;
            run?: string;
          },
        ) => {
          const card = opts.card ?? (opts.cardFile ? await Bun.file(opts.cardFile).text() : "");
          const path = await runPath(opts.run, "delegate");
          if (path.isErr()) return { result: path };
          return {
            result: await call("POST", path.value, {
              stage,
              agent: opts.agent,
              card,
              ...(opts.name ? { name: opts.name } : {}),
              ...(opts.host ? { host: opts.host } : {}),
            }),
          };
        },
      ),
    );

  runs
    .command("wait <worker>")
    .description("Wait until the worker reported, its pane ended, or it sits idle without a report")
    .option("--timeout <ms>", "give up after this long", positiveInt, 600_000)
    .option("--run <id>", "run id (default: latest)")
    .action(
      ctx.action(async (worker: string, opts: { timeout: number; run?: string }) => {
        const path = await runPath(
          opts.run,
          `wait?worker=${encodeURIComponent(worker)}&timeout=${opts.timeout}`,
        );
        if (path.isErr()) return { result: path };
        return { result: await call<WaitOutcome>("GET", path.value) };
      }),
    );

  runs
    .command("collect <worker>")
    .description("The worker's result (summary, artifacts, its question when blocked); closes its pane")
    .option("--run <id>", "run id (default: latest)")
    .action(
      ctx.action(async (worker: string, opts: { run?: string }) => {
        const path = await runPath(opts.run, "collect");
        if (path.isErr()) return { result: path };
        return { result: await call<WorkerResult>("POST", path.value, { worker }) };
      }),
    );

  runs
    .command("workers")
    .description("The run's workers: their panes, states and results so far")
    .option("--run <id>", "run id (default: latest)")
    .action(
      ctx.action(async (opts: { run?: string }) => {
        const path = await runPath(opts.run, "workers");
        if (path.isErr()) return { result: path };
        return { result: await call("GET", path.value) };
      }),
    );

  runs
    .command("result")
    .description(
      "A worker's report: done, blocked (with its question) or failed, with a summary and artifacts",
    )
    .requiredOption("--worker <name>", "the worker's name (METATOR_WORKER in its pane)")
    .addOption(
      new Option("--status <status>", "how the work ended")
        .choices(["done", "blocked", "failed"])
        .makeOptionMandatory(),
    )
    .requiredOption("--summary <text>", "what was done, or why not (a few lines)")
    .option(
      "--artifact <path>",
      "a file the result rests on; repeat for several",
      (v: string, all: string[]) => [...all, v],
      [] as string[],
    )
    .option("--question <text>", "with blocked: the decision a person must take")
    .option("--run <id>", "run id (default: latest)")
    .action(
      ctx.action(
        async (opts: {
          worker: string;
          status: "done" | "blocked" | "failed";
          summary: string;
          artifact: string[];
          question?: string;
          run?: string;
        }) => {
          return {
            result: await ctx
              .runs()
              .resolve("conductor")
              .report({
                ...(opts.run ? { runId: opts.run } : {}),
                worker: opts.worker,
                status: opts.status,
                summary: opts.summary,
                artifacts: opts.artifact,
                ...(opts.question ? { question: opts.question } : {}),
              }),
          };
        },
      ),
    );
}
