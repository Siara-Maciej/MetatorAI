import { err, MetatorError, ok } from "@metator/core";
import { type Command, Option } from "commander";
import type { CommandContext } from "../context.ts";
import { follow, person } from "../live.ts";
import { positiveInt } from "../options.ts";
import { defaultHost, HOSTS, newRun, resume, sessionRows, startDetached } from "../sessions.ts";

/** `run drive|stop|questions|answer|activity|continue` (F8.3, F8.4): the CLI carries a run, people answer. */
export function registerDriveCommands(
  program: Command,
  runs: Command,
  { action, runs: container, terminal }: CommandContext,
): void {
  const root = () => (program.opts() as { root?: string }).root;

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
      return { result: await newRun(container(), terminal, root()) };
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
        let runId = given;
        if (!runId) {
          const rows = await sessionRows(c);
          if (rows.isErr()) return { result: rows };
          const active = rows.value.filter((r) => r.status === "active");
          if (active.length === 0) return { result: err(MetatorError.usage("no active run to continue")) };
          if (terminal) {
            const picked = await terminal.pickRun(
              active.map((r) => ({ runId: r.runId, label: `${r.runId} · ${r.stage}`, hint: r.state })),
            );
            if (!picked) return { result: err(MetatorError.usage("nothing continued")) };
            runId = picked;
          } else runId = (active[0] as { runId: string }).runId;
        }
        const resumed = await resume(c, root(), runId, opts.host);
        if (resumed.isErr()) return { result: resumed };
        if (!terminal) {
          const now = await c.resolve("runDrivers").status(runId);
          return { result: now.map((d) => ({ runId, stage: resumed.value.stage, driver: d })) };
        }
        terminal.show(`run ${runId} · ${resumed.value.stage} · Ctrl+C leaves; the run goes on`);
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
        const host = opts.host ?? defaultHost(c);
        const drivers = c.resolve("runDrivers");
        if (opts.detach) {
          const started = await startDetached(c, root(), id.value, host, opts.maxSteps);
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
