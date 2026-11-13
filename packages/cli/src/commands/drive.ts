import {
  briefOf,
  err,
  labelFor,
  MetatorError,
  ok,
  policyFrom,
  policyRefusal,
  type Result,
  unreadableRunWarning,
} from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { follow, watch } from "../live.ts";
import { byOption, positiveInt, RUN_ARGUMENT, runGiven, runOption } from "../options.ts";
import { defaultHost, HOSTS, newRun, resume, sessionRows, startDetached } from "../sessions.ts";
import type { Terminal } from "../terminal.ts";
import { who } from "../who.ts";

/** `run drive|stop|questions|answer|activity|continue` (F8.3, F8.4): the CLI carries a run, people answer. */
/** The run a command is about; an id that names no run is NOT_FOUND, as `run status` answers. */
async function knownRun(
  c: MetatorContainer,
  given: string | undefined,
): Promise<Result<string, MetatorError>> {
  const repo = c.resolve("runRepository");
  const id = await repo.resolveId(given);
  if (id.isErr()) return id;
  return (await repo.load(id.value)).map(() => id.value);
}

/**
 * `run continue` on an escalated run, at a terminal: the person is asked whether its cause is
 * fixed, and a yes resumes it at the stage it stopped at (what `run resume` records, under their
 * name). A run that is not escalated passes through; a no continues nothing.
 */
export async function offerResume(
  c: MetatorContainer,
  runId: string,
  terminal: Pick<Terminal, "choose">,
): Promise<Result<{ readonly resumed: boolean }, MetatorError>> {
  const record = await c.resolve("runRepository").load(runId);
  if (record.isErr() || record.value.state.status !== "escalated") return ok({ resumed: false });
  const by = await who(c);
  if (by.isErr()) return err(by.error);
  const answer = await terminal.choose(
    `${runId} escalated at ${record.value.state.stage}. Is its cause fixed, so it can go on from there?`,
    [
      { value: "resume", label: "Resume and drive it", hint: `recorded in log.md as resumed by ${by.value}` },
      { value: "leave", label: "Leave it as it is" },
    ],
  );
  if (answer !== "resume")
    return err(
      MetatorError.usage(
        "nothing continued",
        `The run stays escalated: \`metator run resume --run ${runId} --drive\` once its cause is fixed.`,
      ),
    );
  return (await c.resolve("resumeRun").execute({ runId, by: by.value })).map(() => ({ resumed: true }));
}

export function registerDriveCommands(
  program: Command,
  runs: Command,
  { action, runs: container, terminal, root }: CommandContext,
): void {
  // `metator run` in a terminal: a new run, driven in the background, watched and answered here.
  runs.action(
    action(async () => {
      if (!terminal) {
        return {
          result: err(
            MetatorError.usage(
              "`metator run` asks its questions in a terminal",
              "Without one, use `metator run new` and `metator run drive`; `metator help` lists every command.",
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
    .option("--host <host>", `AI host: ${HOSTS.join(", ")} (default: the one the run used)`)
    .action(
      action(async (given: string | undefined, opts: { host?: string }) => {
        const c = container();
        let runId = given;
        if (!runId) {
          const rows = await sessionRows(c);
          if (rows.isErr()) return { result: rows };
          const active = rows.value.filter((r) => r.status === "active");
          const escalated = rows.value.filter((r) => r.status === "escalated").map((r) => r.runId);
          if (active.length > 0 && terminal) {
            const picked = await terminal.pickRun(
              active.map((r) => ({ runId: r.runId, label: `${r.runId} · ${r.stage}`, hint: r.state })),
            );
            if (!picked) return { result: err(MetatorError.usage("nothing continued")) };
            runId = picked;
          } else if (active.length > 0) runId = (active[0] as { runId: string }).runId;
          // An escalated run is the likely reason a person asks: at a terminal it is offered its
          // resume below; without one nothing is resumed unasked, and the hint says how (R9).
          else if (terminal && escalated[0]) runId = escalated[0];
          else
            return {
              result: err(
                new MetatorError("NOT_FOUND", "no active run to continue", {
                  ...(escalated.length > 0
                    ? {
                        hint: `${escalated.length} run(s) escalated and wait for a resume: \`metator run resume --run ${escalated[0]} --by <name> --drive\`.`,
                      }
                    : {}),
                }),
              ),
            };
        }
        if (terminal) {
          const offered = await offerResume(c, runId, terminal);
          if (offered.isErr()) return { result: offered };
        }
        const resumed = await resume(c, root(), runId, opts.host);
        if (resumed.isErr()) return { result: resumed };
        if (!terminal) {
          const now = await c.resolve("runDrivers").status(runId);
          return { result: now.map((d) => ({ runId, stage: resumed.value.stage, driver: d })) };
        }
        const by = await who(c);
        if (by.isErr()) return { result: by };
        terminal.show(`run ${runId} · ${resumed.value.stage} · Ctrl+C leaves; the run goes on`);
        return { result: ok(await follow(c, runId, terminal, by.value)) };
      }),
    );

  meta(runs.command("drive"), { audience: "person" })
    .description("Carry the run stage by stage: scripts, agents through an AI host, questions to people")
    .addOption(runOption())
    .option("--host <host>", `AI host for the agents: ${HOSTS.join(", ")} (default: first of hosts.targets)`)
    .option("--detach", "keep driving in the background after this command returns", false)
    .option("--max-steps <n>", "stop after this many stage transitions", positiveInt, 200)
    .action(
      action(async (opts: { run?: string; host?: string; detach: boolean; maxSteps: number }) => {
        const c = container();
        const id = await c.resolve("runRepository").resolveId(opts.run);
        if (id.isErr()) return { result: id };
        const host = opts.host ?? defaultHost(c);
        if (!c.resolve("agentHosts").has(host))
          return {
            result: err(
              MetatorError.usage(
                `unknown AI host ${host}`,
                `Hosts: ${[...c.resolve("agentHosts").keys()].join(", ")}.`,
              ),
            ),
          };
        const drivers = c.resolve("runDrivers");
        if (opts.detach) {
          const started = await startDetached(c, root(), id.value, host, opts.maxSteps);
          return { result: started.map((d) => ({ runId: id.value, detached: true, ...d })) };
        }
        const claimed = await drivers.claim(id.value, process.pid, host);
        if (claimed.isErr()) return { result: claimed };
        // At a terminal the drive says what it does as it does it; a script gets the one JSON line.
        const watched = terminal ? watch(c, id.value, terminal) : undefined;
        try {
          return {
            result: await c.resolve("driveRun").execute({ runId: id.value, host, maxSteps: opts.maxSteps }),
          };
        } finally {
          await watched?.stop();
          await drivers.release(id.value, process.pid);
        }
      }),
    );

  runs
    .command("revive")
    .description(
      "Start again every drive that died (a restart, a killed process), at the stage it stood; safe to schedule",
    )
    .option("--run <id>", "only this run (default: every run)")
    .action(
      action(async (opts: { run?: string }) => {
        const c = container();
        const ids = opts.run ? [opts.run] : await c.resolve("runRepository").list();
        const revived: { runId: string; stage: string; died: number }[] = [];
        const warnings: string[] = [];
        for (const runId of ids) {
          const record = await c.resolve("runRepository").load(runId);
          if (record.isErr()) {
            // The run a person named is their answer; among all runs, one broken record is skipped and said.
            if (opts.run) return { result: record };
            warnings.push(
              unreadableRunWarning({
                runId,
                file: c.resolve("runRepository").stateFile(runId),
                message: record.error.message,
              }),
            );
            continue;
          }
          if (record.value.state.status !== "active") continue;
          const driver = await c.resolve("runDrivers").status(runId);
          if (driver.isErr()) return { result: driver };
          // No file: nobody drove it, or its drive left on purpose (done, stopped, a host limit).
          if (!driver.value || driver.value.alive) continue;
          const logged = await c.resolve("runJournal").record(runId, {
            type: "drive",
            text: `revived: its drive (process ${driver.value.pid}) had died`,
          });
          if (logged.isErr()) return { result: logged };
          const resumed = await resume(c, root(), runId);
          if (resumed.isErr()) return { result: resumed };
          revived.push({ runId, stage: resumed.value.stage, died: driver.value.pid });
        }
        return { result: ok({ revived }), warnings };
      }),
    );

  runs
    .command("stop")
    .description("Stop the process driving the run; the run stays where it is and can continue")
    .argument(...RUN_ARGUMENT)
    .addOption(runOption())
    .action(
      action(async (word: string | undefined, opts: { run?: string }) => {
        const c = container();
        const run = runGiven(word, opts);
        if (run.isErr()) return { result: run };
        const id = await knownRun(c, run.value);
        if (id.isErr()) return { result: id };
        return {
          result: (await c.resolve("runDrivers").stop(id.value)).map((r) => ({ runId: id.value, ...r })),
        };
      }),
    );

  meta(runs.command("questions"), { reads: true })
    .description("Questions waiting for a person: approvals, agents asking, tool permissions")
    .option("--run <id>", "only this run (default: every run)")
    .option("--all", "include answered questions", false)
    .action(
      action(async (opts: { run?: string; all: boolean }) => {
        const c = container();
        const repo = c.resolve("runRepository");
        const known = opts.run ? await knownRun(c, opts.run) : undefined;
        if (known?.isErr()) return { result: known };
        const ids = known?.isOk() ? [known.value] : await repo.list();
        const out = [];
        for (const runId of ids) {
          const qs = await c.resolve("runJournal").questions(runId);
          if (qs.isErr()) return { result: qs };
          out.push(...qs.value.filter((q) => opts.all || !q.answer));
        }
        return { result: ok({ questions: out }) };
      }),
    );

  meta(runs.command("answer"), { audience: "person" })
    .description(
      "Record the answer to a question; the run continues when a drive is waiting for it (with none, `metator run continue` starts one)",
    )
    .argument("<question>", "question id, e.g. q001")
    .addOption(runOption())
    .option("--choice <labels...>", "the option label(s) chosen")
    .option("--text <text>", "your own words (with Other, or a reason with Reject)")
    .addOption(byOption("who answers"))
    .option(
      "--always",
      "also answer every such question this way from now on (an answer policy in metator/answer-policies.yml)",
      false,
    )
    .action(
      action(
        async (
          question: string,
          opts: { run?: string; choice?: string[]; text?: string; by?: string; always: boolean },
        ) => {
          const c = container();
          const id = await c.resolve("runRepository").resolveId(opts.run);
          if (id.isErr()) return { result: id };
          const by = await who(c, opts.by);
          if (by.isErr()) return { result: by };
          if (!opts.choice && !opts.text) {
            return { result: err(MetatorError.usage("give --choice <label> or --text <answer>")) };
          }
          let input = { choices: opts.choice ?? [], ...(opts.text ? { text: opts.text } : {}) };
          const journal = c.resolve("runJournal");
          if (opts.always) {
            const all = await journal.questions(id.value);
            if (all.isErr()) return { result: all };
            const q = all.value.find((x) => x.id === question);
            if (!q) return { result: err(MetatorError.notFound(`question ${question} of run ${id.value}`)) };
            // The policy is judged and written with the labels the question has, however they were typed.
            const labels = q.options.map((o) => o.label);
            input = { ...input, choices: input.choices.map((choice) => labelFor(labels, choice)) };
            const refused = policyRefusal(q, input.choices.length > 0 ? input.choices : ["Other"]);
            if (refused)
              return { result: err(MetatorError.usage(`no policy: ${refused}`, "Answer without --always.")) };
          }
          const answered = await journal.answer(id.value, question, { ...input, by: by.value });
          if (answered.isErr() || !opts.always) return { result: answered };
          const store = c.resolve("answerPolicyStore");
          const taken = await store.list();
          if (taken.isErr()) return { result: taken };
          const policy = policyFrom(
            answered.value,
            input,
            by.value,
            c.resolve("clock").now().toISOString(),
            taken.value.map((p) => p.id),
          );
          const added = await store.add(policy);
          return { result: added.map((p) => ({ ...answered.value, policy: p })) };
        },
      ),
    );

  meta(runs.command("brief"), { reads: true, readsWith: ["--peek"] })
    .description(
      "What happened in a run since you last looked: transitions, files, answers, questions, errors",
    )
    .addOption(runOption())
    .option("--since <time>", "from this ISO time (default: your last brief of the run, else its start)")
    .option("--peek", "do not mark the run as read", false)
    .argument(...RUN_ARGUMENT)
    .action(
      action(async (word: string | undefined, opts: { run?: string; since?: string; peek: boolean }) => {
        const c = container();
        const run = runGiven(word, opts);
        if (run.isErr()) return { result: run };
        const id = await c.resolve("runRepository").resolveId(run.value);
        if (id.isErr()) return { result: id };
        if (opts.since && Number.isNaN(Date.parse(opts.since)))
          return { result: err(MetatorError.usage(`--since ${opts.since}: expected an ISO time`)) };
        const journal = c.resolve("runJournal");
        const seen = await journal.seen(id.value);
        if (seen.isErr()) return { result: seen };
        const record = await c.resolve("runRepository").load(id.value);
        if (record.isErr()) return { result: record };
        const since = opts.since
          ? new Date(opts.since).toISOString()
          : (seen.value ?? record.value.createdAt);
        const activity = await journal.activity(id.value);
        if (activity.isErr()) return { result: activity };
        const brief = briefOf(activity.value, since);
        if (!opts.peek) {
          const marked = await journal.markSeen(id.value);
          if (marked.isErr()) return { result: marked };
        }
        return {
          result: ok({
            runId: id.value,
            status: record.value.state.status,
            stage: record.value.state.stage,
            ...brief,
          }),
        };
      }),
    );

  meta(runs.command("activity"), { reads: true })
    .description("What the drive did: stages, agents, tools, questions, answers, transitions")
    .addOption(runOption())
    .option("--tail <n>", "only the last n entries", positiveInt)
    .argument(...RUN_ARGUMENT)
    .action(
      action(async (word: string | undefined, opts: { run?: string; tail?: number }) => {
        const c = container();
        const run = runGiven(word, opts);
        if (run.isErr()) return { result: run };
        const id = await knownRun(c, run.value);
        if (id.isErr()) return { result: id };
        const activity = await c.resolve("runJournal").activity(id.value);
        if (activity.isErr()) return { result: activity };
        const driver = await c.resolve("runDrivers").status(id.value);
        if (driver.isErr()) return { result: driver };
        const entries = opts.tail ? activity.value.slice(-opts.tail) : activity.value;
        return { result: ok({ runId: id.value, driver: driver.value, entries }) };
      }),
    );

  const policies = program
    .command("policy")
    .description("Answer policies: questions the team answers the same way every time");
  meta(policies.command("list"), { reads: true })
    .description("Every answer policy in metator/answer-policies.yml")
    .action(
      action(async () => ({
        result: (await container().resolve("answerPolicyStore").list()).map((p) => ({ policies: p })),
      })),
    );
  policies
    .command("rm")
    .description("Remove an answer policy: such questions ask a person again")
    .argument("<id>", "policy id")
    .action(
      action(async (id: string) => ({ result: await container().resolve("answerPolicyStore").remove(id) })),
    );
}
