import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, hostRefusal, MetatorError, notDrivable, ok, type Result } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { type FollowResult, follow, person } from "./live.ts";
import type { Terminal } from "./terminal.ts";

/**
 * The AI hosts that drive agents without a terminal, as the help names them. Which hosts exist is
 * the runtime's knowledge (`agentHosts`): a `--host` it does not hold is refused there, with the
 * list it does hold (a test's scenario host is one only while a scenario is given).
 */
export const HOSTS = ["claude", "copilot"] as const;
const HOST_OF: Record<string, (typeof HOSTS)[number]> = { claude: "claude", copilot: "copilot" };

/** The host a new run or question uses: `$METATOR_HOST` when it names a host, else the first of hosts.targets. */
export const defaultHost = (
  c: MetatorContainer,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const chosen = env.METATOR_HOST;
  if (chosen && c.resolve("agentHosts").has(chosen)) return chosen;
  return HOST_OF[c.resolve("config").config.hosts.targets[0] ?? "claude"] ?? "claude";
};

/**
 * Starts `run drive` for the run in its own process (the same entry point as this command).
 * Refused up front where that process would end at once without a word: a run that is not
 * active (an escalated one names its resume), a host whose program is not installed.
 */
export async function startDetached(
  c: MetatorContainer,
  root: string | undefined,
  runId: string,
  host: string,
  maxSteps = 200,
) {
  const record = await c.resolve("runRepository").load(runId);
  if (record.isErr()) return err(record.error);
  const refused = notDrivable(record.value);
  if (refused) return err(refused);
  if (record.value.state.status !== "active")
    return err(
      new MetatorError(
        "TRANSITION_DENIED",
        `run ${runId} is ${record.value.state.status}; there is nothing to drive`,
      ),
    );
  const missing = hostRefusal(host, [...c.resolve("agentHosts").keys()], c.resolve("driveHostProblem"));
  if (missing) return err(missing);
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

export interface SessionRow {
  readonly runId: string;
  readonly workflow: string;
  readonly stage: string;
  readonly status: string;
  readonly waiting: number;
  readonly driving: boolean;
  /** Its drive process ended without leaving: `run revive` starts it again. */
  readonly died: boolean;
  /** waits for you (n) · working · died · stopped · done · escalated · aborted */
  readonly state: string;
}

/** Every run as a session, active ones first, newest first. */
export async function sessionRows(c: MetatorContainer): Promise<Result<readonly SessionRow[], MetatorError>> {
  const listed = await c.resolve("listRuns").execute();
  if (listed.isErr()) return err(listed.error);
  const rows: SessionRow[] = [];
  for (const r of listed.value.runs) {
    const open = await c.resolve("runJournal").questions(r.runId);
    const waiting = open.isOk() ? open.value.filter((q) => !q.answer).length : 0;
    const driver = await c.resolve("runDrivers").status(r.runId);
    const driving = driver.isOk() && driver.value?.alive === true;
    const died = r.status === "active" && driver.isOk() && driver.value !== null && !driver.value.alive;
    const state =
      r.status !== "active"
        ? r.status
        : waiting > 0
          ? `waits for you (${waiting})`
          : driving
            ? "working"
            : died
              ? "died"
              : "stopped";
    rows.push({
      runId: r.runId,
      workflow: r.workflow,
      stage: r.stage,
      status: r.status,
      waiting,
      driving,
      died,
      state,
    });
  }
  return ok([...rows.filter((r) => r.status === "active"), ...rows.filter((r) => r.status !== "active")]);
}

/** The new-run wizard, then the run driven in the background and followed here. */
export async function newRun(
  c: MetatorContainer,
  terminal: Terminal,
  root: string | undefined,
): Promise<Result<FollowResult, MetatorError>> {
  const scan = await c.resolve("workflowCatalog").scan();
  if (scan.workflows.length === 0)
    return err(MetatorError.usage("no workflows here", "Run `metator setup` to install them."));
  // Only the hosts that can run agents on this machine are offered.
  const problem = c.resolve("driveHostProblem");
  const hosts = [...c.resolve("agentHosts").keys()].filter((h) => problem(h) === undefined);
  if (hosts.length === 0)
    return err(
      MetatorError.usage(
        "no AI host is installed here",
        "Install GitHub Copilot CLI or Claude Code, then run `metator doctor`.",
      ),
    );
  const answers = await terminal.newRun({
    workflows: scan.workflows.map((w) => ({
      id: w.spec.id,
      ...(w.spec.description ? { description: w.spec.description } : {}),
      ...(w.spec.autonomy ? { autonomy: w.spec.autonomy } : {}),
    })),
    hosts,
    defaultHost: defaultHost(c),
  });
  if (!answers) return err(MetatorError.usage("no run started"));
  const run = await c.resolve("initRun").execute({
    workflow: answers.workflow,
    task: answers.task,
    autonomy: answers.autonomy,
    ...(answers.worktree ? { worktree: {} } : {}),
  });
  if (run.isErr()) return err(run.error);
  if (answers.worktree) {
    // The worktree's dependencies first: the run's tests and gates run there.
    const setup = await c.resolve("setupWorktree").execute({ run: run.value.runId });
    terminal.show(
      setup.isOk()
        ? `worktree ${setup.value.worktree}: dependencies ${setup.value.dependencies}`
        : `worktree setup failed: ${setup.error.message}`,
    );
  }
  const started = await startDetached(c, root, run.value.runId, answers.host);
  if (started.isErr()) return err(started.error);
  terminal.show(`run ${run.value.runId} · ${answers.host} · Ctrl+C leaves; the run goes on`);
  return ok(await follow(c, run.value.runId, terminal, person()));
}

/** Makes sure an active run has a live driver, with the host it used unless told otherwise. */
export async function resume(
  c: MetatorContainer,
  root: string | undefined,
  runId: string,
  host?: string,
): Promise<Result<{ readonly stage: string; readonly started: boolean }, MetatorError>> {
  const record = await c.resolve("runRepository").load(runId);
  if (record.isErr()) return err(record.error);
  const escalated = notDrivable(record.value);
  if (escalated) return err(escalated);
  if (record.value.state.status !== "active") {
    return err(
      new MetatorError(
        "TRANSITION_DENIED",
        `run ${runId} is ${record.value.state.status}; there is nothing to continue`,
      ),
    );
  }
  const driver = await c.resolve("runDrivers").status(runId);
  if (driver.isErr()) return err(driver.error);
  if (driver.value?.alive) return ok({ stage: record.value.state.stage, started: false });
  const hosts = c.resolve("agentHosts");
  const chosen =
    host ?? (record.value.host && hosts.has(record.value.host) ? record.value.host : defaultHost(c));
  const started = await startDetached(c, root, runId, chosen);
  if (started.isErr()) return err(started.error);
  return ok({ stage: record.value.state.stage, started: true });
}
