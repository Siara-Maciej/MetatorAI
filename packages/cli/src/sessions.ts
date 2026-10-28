import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, MetatorError, ok, type Result } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { type FollowResult, follow, person } from "./live.ts";
import type { Terminal } from "./terminal.ts";

export const HOSTS = ["claude", "copilot", "scenario"] as const;
const HOST_OF: Record<string, (typeof HOSTS)[number]> = { claude: "claude", copilot: "copilot" };

/** The host a new run uses: the first of hosts.targets. */
export const defaultHost = (c: MetatorContainer): string =>
  HOST_OF[c.resolve("config").config.hosts.targets[0] ?? "claude"] ?? "claude";

/** Starts `run drive` for the run in its own process (the same entry point as this command). */
export function startDetached(
  c: MetatorContainer,
  root: string | undefined,
  runId: string,
  host: string,
  maxSteps = 200,
) {
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
  /** waits for you (n) · driving · stopped · done · escalated · aborted */
  readonly state: string;
}

/** Every run as a session, active ones first, newest first. */
export async function sessionRows(c: MetatorContainer): Promise<Result<readonly SessionRow[], MetatorError>> {
  const listed = await c.resolve("listRuns").execute();
  if (listed.isErr()) return err(listed.error);
  const rows: SessionRow[] = [];
  for (const r of listed.value) {
    const open = await c.resolve("runJournal").questions(r.runId);
    const waiting = open.isOk() ? open.value.filter((q) => !q.answer).length : 0;
    const driver = await c.resolve("runDrivers").status(r.runId);
    const driving = driver.isOk() && driver.value?.alive === true;
    const state =
      r.status !== "active"
        ? r.status
        : waiting > 0
          ? `waits for you (${waiting})`
          : driving
            ? "driving"
            : "stopped";
    rows.push({
      runId: r.runId,
      workflow: r.workflow,
      stage: r.stage,
      status: r.status,
      waiting,
      driving,
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
  const answers = await terminal.newRun({
    workflows: scan.workflows.map((w) => ({
      id: w.spec.id,
      ...(w.spec.description ? { description: w.spec.description } : {}),
    })),
    hosts: [...c.resolve("agentHosts").keys()],
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
  if (record.value.state.status !== "active") {
    return err(
      MetatorError.usage(`run ${runId} is ${record.value.state.status}; there is nothing to continue`),
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
