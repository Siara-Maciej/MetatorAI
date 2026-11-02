import type { AgentTask } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock, InteractiveHost, InteractiveSession, PtySize } from "../ports/index.ts";
import type { RunJournal } from "./drive.ts";
import type { RunRepository } from "./run-repository.ts";

/** How much of a session's output a late viewer gets. */
const BACKLOG_BYTES = 200_000;
const DEFAULT_SIZE: PtySize = { cols: 120, rows: 36 };

export interface PtyBrokerDependencies {
  readonly repo: RunRepository;
  readonly journal: Pick<RunJournal, "record" | "questions">;
  readonly hosts: ReadonlyMap<string, InteractiveHost>;
  readonly clock: Clock;
  /** Absolute repository root. */
  readonly root: string;
  /** No output for this long, and no open question, is idleness (SupervisorPolicy; default 90 s). */
  readonly idleMs?: number;
  /** Schedules a check (setTimeout); returns what cancels it. Injected so tests run without waiting. */
  readonly after?: (ms: number, fn: () => void) => () => void;
}

export interface PtyView {
  readonly runId: string;
  readonly host: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly alive: boolean;
  readonly exitCode?: number;
  readonly idle: boolean;
}

interface Live {
  readonly host: string;
  readonly session: InteractiveSession;
  backlog: string;
  alive: boolean;
  exitCode?: number;
  idle: boolean;
  cancelIdle?: () => void;
  readonly listeners: Set<(event: PtyEvent) => void>;
}

export type PtyEvent =
  | { readonly type: "data"; readonly data: string }
  | { readonly type: "exit"; readonly code: number }
  | { readonly type: "idle" };

/**
 * The PTY broker (D3, ADR-0077): one interactive host session per run, kept by the daemon.
 * Output fans out to every viewer; input goes to the PTY only from the person who holds the
 * driver lock (state.json, read at each write). Exits and idleness land in the activity.
 */
export class PtyBroker {
  private readonly live = new Map<string, Live>();

  constructor(private readonly d: PtyBrokerDependencies) {}

  /** Starts (or resumes) the run's session; an open one is returned as it is. */
  async open(input: {
    readonly runId?: string;
    readonly host?: string;
    readonly size?: PtySize;
  }): Promise<Result<PtyView, MetatorError>> {
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const runId = id.value;
    const current = this.live.get(runId);
    if (current?.alive) return ok(this.view(runId, current));
    const record = await this.d.repo.load(runId);
    if (record.isErr()) return err(record.error);
    if (record.value.state.status !== "active")
      return err(
        MetatorError.usage(`run ${runId} is ${record.value.state.status}; there is no session to open`),
      );
    const hostId = input.host ?? record.value.host ?? [...this.d.hosts.keys()][0];
    const host = hostId ? this.d.hosts.get(hostId) : undefined;
    if (!host)
      return err(
        MetatorError.usage(
          `unknown interactive host ${hostId ?? "(none)"}`,
          `Hosts: ${[...this.d.hosts.keys()].join(", ") || "none"}.`,
        ),
      );
    const cwd = record.value.worktree ? `${this.d.root}/${record.value.worktree.path}` : this.d.root;
    const task: AgentTask = {
      agent: "session",
      prompt: record.value.task,
      cwd,
      projectRoot: this.d.root,
      runDir: `${cwd}/${this.d.repo.runDir(runId)}`,
      driven: true,
    };
    const size = input.size ?? DEFAULT_SIZE;
    const resumable = record.value.host === host.id ? record.value.hostSession : undefined;
    const started = resumable ? await host.resume(resumable, task, size) : await host.start(task, size);
    if (started.isErr()) return err(started.error);
    const session = started.value;
    const entry: Live = {
      host: host.id,
      session,
      backlog: "",
      alive: true,
      idle: false,
      listeners: new Set(),
    };
    this.live.set(runId, entry);
    const saved = await this.d.repo.save({
      ...record.value,
      host: host.id,
      hostSession: session.sessionId,
      updatedAt: this.d.clock.now().toISOString(),
    });
    if (saved.isErr()) return err(saved.error);
    await this.d.journal.record(runId, {
      type: "agent",
      origin: "pty",
      agent: host.id,
      text: `${resumable ? "resumed" : "started"} session ${session.sessionId} (pid ${session.pty.pid})`,
    });
    session.pty.onData((data) => {
      entry.backlog = (entry.backlog + data).slice(-BACKLOG_BYTES);
      entry.idle = false;
      this.armIdle(runId, entry);
      for (const l of entry.listeners) l({ type: "data", data });
    });
    session.pty.onExit((code) => {
      entry.alive = false;
      entry.exitCode = code;
      entry.cancelIdle?.();
      void this.d.journal.record(runId, {
        type: "agent",
        origin: "pty",
        agent: host.id,
        text: `session ${session.sessionId} exited with ${code}`,
      });
      for (const l of entry.listeners) l({ type: "exit", code });
    });
    this.armIdle(runId, entry);
    return ok(this.view(runId, entry));
  }

  /** Output since the session started (the last 200 kB), for a viewer that joins late. */
  backlog(runId: string): string {
    return this.live.get(runId)?.backlog ?? "";
  }

  subscribe(runId: string, listener: (event: PtyEvent) => void): () => void {
    const entry = this.live.get(runId);
    if (!entry) return () => {};
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  /** Keystrokes from a person: only the one who holds the driver lock, read from state.json now. */
  async write(input: {
    readonly runId: string;
    readonly data: string;
    readonly by: string;
  }): Promise<Result<void, MetatorError>> {
    const entry = this.live.get(input.runId);
    if (!entry?.alive) return err(MetatorError.notFound(`a live session of run ${input.runId}`));
    const record = await this.d.repo.load(input.runId);
    if (record.isErr()) return err(record.error);
    const driver = record.value.driver;
    if (driver?.by !== "human" || driver.attachedBy !== input.by)
      return err(
        MetatorError.usage(
          driver?.by === "human"
            ? `run ${input.runId} is driven by ${driver.attachedBy}: only they may type`
            : `run ${input.runId} is driven by the agent: attach first (\`metator run attach --by ${input.by}\`)`,
        ),
      );
    entry.session.pty.write(input.data);
    return ok(undefined);
  }

  /** The supervisor's words to an idle session: typed only while the agent drives, never over a person. */
  async nudge(runId: string, text: string): Promise<Result<void, MetatorError>> {
    const entry = this.live.get(runId);
    if (!entry?.alive) return err(MetatorError.notFound(`a live session of run ${runId}`));
    const record = await this.d.repo.load(runId);
    if (record.isErr()) return err(record.error);
    if (record.value.driver?.by === "human")
      return err(
        MetatorError.usage(
          `run ${runId} is driven by ${record.value.driver.attachedBy}: no nudge over a person`,
        ),
      );
    entry.session.pty.write(`${text}\r`);
    entry.idle = false;
    this.armIdle(runId, entry);
    return ok(undefined);
  }

  resize(runId: string, size: PtySize): Result<void, MetatorError> {
    const entry = this.live.get(runId);
    if (!entry?.alive) return err(MetatorError.notFound(`a live session of run ${runId}`));
    entry.session.pty.resize(size.cols, size.rows);
    return ok(undefined);
  }

  status(runId: string): PtyView | undefined {
    const entry = this.live.get(runId);
    return entry ? this.view(runId, entry) : undefined;
  }

  list(): readonly PtyView[] {
    return [...this.live.entries()].map(([runId, entry]) => this.view(runId, entry));
  }

  async close(runId: string): Promise<Result<{ readonly closed: boolean }, MetatorError>> {
    const entry = this.live.get(runId);
    if (!entry) return ok({ closed: false });
    entry.cancelIdle?.();
    if (entry.alive) entry.session.pty.kill();
    this.live.delete(runId);
    return ok({ closed: true });
  }

  /** No output for `idleMs` while no question is open: the supervisor's cue to nudge. */
  private armIdle(runId: string, entry: Live): void {
    entry.cancelIdle?.();
    const ms = this.d.idleMs ?? 90_000;
    const after =
      this.d.after ??
      ((delay, fn) => {
        const t = setTimeout(fn, delay);
        return () => clearTimeout(t);
      });
    entry.cancelIdle = after(ms, () => {
      void (async () => {
        if (!entry.alive || entry.idle) return;
        const questions = await this.d.journal.questions(runId);
        if (questions.isOk() && questions.value.some((q) => !q.answer)) return;
        entry.idle = true;
        await this.d.journal.record(runId, {
          type: "idle",
          origin: "pty",
          agent: entry.host,
          text: `no output for ${Math.round(ms / 1000)} s and no open question`,
        });
        for (const l of entry.listeners) l({ type: "idle" });
      })();
    });
  }

  private view(runId: string, entry: Live): PtyView {
    return {
      runId,
      host: entry.host,
      sessionId: entry.session.sessionId,
      pid: entry.session.pty.pid,
      alive: entry.alive,
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
      idle: entry.idle,
    };
  }
}
