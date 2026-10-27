import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, MetatorError, ok } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { type Command, Option } from "commander";
import type { CommandContext } from "../context.ts";
import { follow, person } from "../live.ts";
import { positiveInt } from "../options.ts";

const HOSTS = ["claude", "copilot", "scenario"] as const;
const HOST_OF: Record<string, (typeof HOSTS)[number]> = { claude: "claude", copilot: "copilot" };

/** Starts `run drive` for the run in its own process (the same entry point as this command). */
function startDetached(program: Command, c: MetatorContainer, runId: string, host: string, maxSteps: number) {
  const root = (program.opts() as { root?: string }).root;
  const argv = [
    process.argv[0] as string,
    process.argv[1] as string,
    ...(root ? ["--root", root] : []),
    "run",
    "drive",
    "--run",
    runId,
    "--host",
    host,
    "--max-steps",
    String(maxSteps),
  ];
  return c.resolve("runDrivers").start({
    runId,
    host,
    argv,
    cwd: c.resolve("root"),
    logFile: join(tmpdir(), `metator-drive-${runId}.log`),
  });
}

const defaultHost = (c: MetatorContainer) =>
  HOST_OF[c.resolve("config").config.hosts.targets[0] ?? "claude"] ?? "claude";

/** `run drive|stop|questions|answer|activity|continue` (F8.3, F8.4): the CLI carries a run, people answer. */
export function registerDriveCommands(
  program: Command,
  runs: Command,
  { action, container, terminal }: CommandContext,
): void {
  // `metator run` in a terminal: a new run, driven in the background, watched and answered here.
  runs.action(
    action(async () => {
      if (!terminal) {
        return {
          result: err(
            MetatorError.usage(
              "`metator run` asks its questions in a terminal",
              "Without one, use `metator run init` and `metator run drive`; `metator help` lists every command.",
            ),
          ),
        };
      }
      const c = container();
      const scan = await c.resolve("workflowCatalog").scan();
      if (scan.workflows.length === 0) {
        return {
          result: err(MetatorError.usage("no workflows here", "Run `metator setup` to install them.")),
        };
      }
      const answers = await terminal.newRun({
        workflows: scan.workflows.map((w) => ({
          id: w.spec.id,
          ...(w.spec.description ? { description: w.spec.description } : {}),
        })),
        hosts: [...c.resolve("agentHosts").keys()],
        defaultHost: defaultHost(c),
      });
      if (!answers) return { result: err(MetatorError.usage("no run started")) };
      const run = await c.resolve("initRun").execute({
        workflow: answers.workflow,
        task: answers.task,
        autonomy: answers.autonomy,
        ...(answers.worktree ? { worktree: {} } : {}),
      });
      if (run.isErr()) return { result: run };
      const started = await startDetached(program, c, run.value.runId, answers.host, 200);
      if (started.isErr()) return { result: started };
      terminal.show(`run ${run.value.runId} · ${answers.host} · Ctrl+C leaves; the run goes on`);
      return { result: ok(await follow(c, run.value.runId, terminal, person())) };
    }),
  );

  runs
    .command("continue")
    .description("Continue a run: pick one that waits for you or stopped, drive it again and watch it")
    .argument("[run]", "run id (default: pick in a terminal, else the latest active run)")
    .addOption(new Option("--host <host>", "AI host (default: the one the run used)").choices(HOSTS))
    .action(
      action(async (given: string | undefined, opts: { host?: string }) => {
        const c = container();
        const listed = await c.resolve("listRuns").execute();
        if (listed.isErr()) return { result: listed };
        const active = listed.value.filter((r) => r.status === "active");
        let runId = given;
        if (!runId) {
          if (active.length === 0) return { result: err(MetatorError.usage("no active run to continue")) };
          if (terminal) {
            const choices = [];
            for (const r of active) {
              const open = (await c.resolve("runJournal").questions(r.runId)).map(
                (qs) => qs.filter((q) => !q.answer).length,
              );
              const driver = await c.resolve("runDrivers").status(r.runId);
              const waiting = open.isOk() ? open.value : 0;
              const hint =
                waiting > 0
                  ? `waits for you (${waiting})`
                  : driver.isOk() && driver.value?.alive
                    ? "driving"
                    : "stopped";
              choices.push({ runId: r.runId, label: `${r.runId} · ${r.stage}`, hint });
            }
            const picked = await terminal.pickRun(choices);
            if (!picked) return { result: err(MetatorError.usage("nothing continued")) };
            runId = picked;
          } else runId = (active[0] as { runId: string }).runId;
        }
        const record = await c.resolve("runRepository").load(runId);
        if (record.isErr()) return { result: record };
        if (record.value.state.status !== "active") {
          return {
            result: err(
              MetatorError.usage(
                `run ${runId} is ${record.value.state.status}; there is nothing to continue`,
              ),
            ),
          };
        }
        const driver = await c.resolve("runDrivers").status(runId);
        if (driver.isErr()) return { result: driver };
        const hosts = c.resolve("agentHosts");
        const host =
          opts.host ??
          (record.value.host && hosts.has(record.value.host) ? record.value.host : defaultHost(c));
        if (!driver.value?.alive) {
          const started = await startDetached(program, c, runId, host, 200);
          if (started.isErr()) return { result: started };
        }
        if (!terminal) {
          const now = await c.resolve("runDrivers").status(runId);
          return { result: now.map((d) => ({ runId, stage: record.value.state.stage, driver: d })) };
        }
        terminal.show(`run ${runId} · ${record.value.state.stage} · Ctrl+C leaves; the run goes on`);
        return { result: ok(await follow(c, runId, terminal, person())) };
      }),
    );

  runs
    .command("drive")
    .description("Carry the run stage by stage: scripts, agents through an AI host, questions to people")
    .option("--run <id>", "run id (default: latest)")
    .addOption(
      new Option("--host <host>", "AI host for the agents (default: first of hosts.targets)").choices(HOSTS),
    )
    .option("--detach", "keep driving in the background after this command returns", false)
    .option("--max-steps <n>", "stop after this many stage transitions", positiveInt, 200)
    .action(
      action(async (opts: { run?: string; host?: string; detach: boolean; maxSteps: number }) => {
        const c = container();
        const id = await c.resolve("runRepository").resolveId(opts.run);
        if (id.isErr()) return { result: id };
        const host =
          opts.host ?? HOST_OF[c.resolve("config").config.hosts.targets[0] ?? "claude"] ?? "claude";
        const drivers = c.resolve("runDrivers");
        if (opts.detach) {
          const started = await startDetached(program, c, id.value, host, opts.maxSteps);
          return { result: started.map((d) => ({ runId: id.value, detached: true, ...d })) };
        }
        const claimed = await drivers.claim(id.value, process.pid, host);
        if (claimed.isErr()) return { result: claimed };
        try {
          return {
            result: await c.resolve("driveRun").execute({ runId: id.value, host, maxSteps: opts.maxSteps }),
          };
        } finally {
          await drivers.release(id.value, process.pid);
        }
      }),
    );

  runs
    .command("stop")
    .description("Stop the process driving the run; the run stays where it is and can continue")
    .option("--run <id>", "run id (default: latest)")
    .action(
      action(async (opts: { run?: string }) => {
        const c = container();
        const id = await c.resolve("runRepository").resolveId(opts.run);
        if (id.isErr()) return { result: id };
        return {
          result: (await c.resolve("runDrivers").stop(id.value)).map((r) => ({ runId: id.value, ...r })),
        };
      }),
    );

  runs
    .command("questions")
    .description("Questions waiting for a person: HITL gates, agents asking, tool permissions")
    .option("--run <id>", "only this run (default: every run)")
    .option("--all", "include answered questions", false)
    .action(
      action(async (opts: { run?: string; all: boolean }) => {
        const c = container();
        const repo = c.resolve("runRepository");
        const ids = opts.run ? [opts.run] : await repo.list();
        const out = [];
        for (const runId of ids) {
          const qs = await c.resolve("runJournal").questions(runId);
          if (qs.isErr()) return { result: qs };
          out.push(...qs.value.filter((q) => opts.all || !q.answer));
        }
        return { result: ok({ questions: out }) };
      }),
    );

  runs
    .command("answer")
    .description("Answer a question; the drive waiting for it continues")
    .argument("<question>", "question id, e.g. q001")
    .option("--run <id>", "run id (default: latest)")
    .option("--choice <labels...>", "the option label(s) chosen")
    .option("--text <text>", "your own words (with Other, or a reason with Reject)")
    .requiredOption("--by <name>", "who answers")
    .action(
      action(
        async (question: string, opts: { run?: string; choice?: string[]; text?: string; by: string }) => {
          const c = container();
          const id = await c.resolve("runRepository").resolveId(opts.run);
          if (id.isErr()) return { result: id };
          if (!opts.choice && !opts.text) {
            return { result: err(MetatorError.usage("give --choice <label> or --text <answer>")) };
          }
          return {
            result: await c.resolve("runJournal").answer(id.value, question, {
              choices: opts.choice ?? [],
              by: opts.by,
              ...(opts.text ? { text: opts.text } : {}),
            }),
          };
        },
      ),
    );

  runs
    .command("activity")
    .description("What the drive did: stages, agents, tools, questions, answers, transitions")
    .option("--run <id>", "run id (default: latest)")
    .option("--tail <n>", "only the last n entries", positiveInt)
    .action(
      action(async (opts: { run?: string; tail?: number }) => {
        const c = container();
        const id = await c.resolve("runRepository").resolveId(opts.run);
        if (id.isErr()) return { result: id };
        const activity = await c.resolve("runJournal").activity(id.value);
        if (activity.isErr()) return { result: activity };
        const driver = await c.resolve("runDrivers").status(id.value);
        if (driver.isErr()) return { result: driver };
        const entries = opts.tail ? activity.value.slice(-opts.tail) : activity.value;
        return { result: ok({ runId: id.value, driver: driver.value, entries }) };
      }),
    );
}
