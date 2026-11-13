import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, MetatorError, ok, type Result } from "@metator/core";
import type { BootstrapOptions, MetatorContainer } from "@metator/runtime";
import { callDaemon, findDaemon } from "./daemon-client.ts";
import { type FollowResult, follow } from "./live.ts";
import type { Terminal } from "./terminal.ts";
import { who } from "./who.ts";

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
 * How this program starts a run's drive as a background process (the `DetachedDrive` port):
 * `run drive` for the run through the same entry point as this command. Whether a drive may
 * start at all is core's decision (`StartDrive`, `EnsureDriven`); this only makes the process.
 */
export const detachedDrive =
  (): NonNullable<BootstrapOptions["detachedDrive"]> =>
  ({ runDrivers, root }) => ({
    start: ({ runId, host, maxSteps }) =>
      runDrivers.start({
        runId,
        host,
        argv: [
          process.argv[0] as string,
          process.argv[1] as string,
          "--root",
          root,
          "run",
          "drive",
          "--run",
          runId,
          "--host",
          host,
          "--max-steps",
          String(maxSteps ?? 200),
        ],
        cwd: root,
        logFile: join(tmpdir(), `metator-drive-${runId}.log`),
      }),
  });

/**
 * A run's panes as a command reaches them (the `RunPanes` port): they live in the daemon's
 * process, so a command asks the daemon, and the daemon itself closes them directly. With no
 * daemon there are none, which is an error the caller leaves out of its answer.
 */
export const runPanes =
  (): NonNullable<BootstrapOptions["runPanes"]> =>
  ({ panes, root }) => ({
    closeRun: async (runId) => {
      const daemon = findDaemon(root);
      if (daemon.isErr()) return err(daemon.error);
      if (daemon.value.pid === process.pid) return panes.closeRun(runId);
      return callDaemon(daemon.value, "POST", `/runs/${encodeURIComponent(runId)}/close-panes`, {});
    },
  });

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
  const by = await who(c);
  if (by.isErr()) return err(by.error);
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
  // The run, its worktree's dependencies and its drive: the same start as every other front.
  const started = await c.resolve("startRun").execute({
    workflow: answers.workflow,
    task: answers.task,
    autonomy: answers.autonomy,
    ...(answers.worktree ? { worktree: {} } : {}),
    drive: { host: answers.host },
  });
  if (started.isErr()) return err(started.error);
  const { run, setup, setupError, driveError } = started.value;
  if (setup) terminal.show(`worktree ${setup.worktree}: dependencies ${setup.dependencies}`);
  if (setupError) terminal.show(`worktree setup failed: ${setupError}`);
  if (driveError)
    return err(
      MetatorError.usage(
        driveError.message,
        driveError.hint ?? `Start it later: \`metator run continue ${run.runId}\`.`,
      ),
    );
  terminal.show(`run ${run.runId} · ${answers.host} · Ctrl+C leaves; the run goes on`);
  return ok(await follow(c, run.runId, terminal, by.value));
}

/** Makes sure an active run has a live driver, with the host it used unless told otherwise (`EnsureDriven`). */
export const resume = (c: MetatorContainer, runId: string, host?: string) =>
  c.resolve("ensureDriven").execute({ runId, ...(host ? { host } : {}) });
