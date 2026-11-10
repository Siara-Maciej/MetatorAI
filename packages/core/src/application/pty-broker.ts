import { MetatorError } from "../domain/errors.ts";
import type { PaneRole } from "../domain/layout.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock, PtyHandle, PtySize } from "../ports/index.ts";
import type { RunJournal } from "./drive.ts";
import type { RunRepository } from "./run-repository.ts";

/** How much of a pane's output a late viewer gets. */
const BACKLOG_BYTES = 200_000;

export interface PtyBrokerDependencies {
  readonly repo: Pick<RunRepository, "load">;
  readonly journal: Pick<RunJournal, "record" | "questions">;
  /** No output for this long, and no open question, is idleness (SupervisorPolicy; default 90 s). */
  readonly idleMs?: number;
  /** Schedules a check (setTimeout); returns what cancels it. Injected so tests run without waiting. */
  readonly after?: (ms: number, fn: () => void) => () => void;
  /** Stamps output and hook calls (the pane sensor reads them); the wall clock by default. */
  readonly clock?: Clock;
}

export interface PtyView {
  readonly paneId: string;
  readonly runId?: string;
  readonly role: PaneRole;
  readonly host: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly alive: boolean;
  readonly exitCode?: number;
  readonly idle: boolean;
  /** When the terminal last printed (ISO). */
  readonly lastOutputAt: string;
  /** When a hook of the pane's session last called in (ISO), if ever (R3). */
  readonly lastHookAt?: string;
}

interface Live {
  readonly runId?: string;
  readonly role: PaneRole;
  readonly host: string;
  readonly sessionId: string;
  readonly pty: PtyHandle;
  backlog: string;
  alive: boolean;
  exitCode?: number;
  idle: boolean;
  lastOutputAt: Date;
  lastHookAt?: Date;
  cancelIdle?: () => void;
  readonly listeners: Set<(event: PtyEvent) => void>;
}

export type PtyEvent =
  | { readonly type: "data"; readonly data: string }
  | { readonly type: "exit"; readonly code: number }
  | { readonly type: "idle" };

/**
 * The PTY broker (D3, R1): the live terminals of the daemon, one per pane. Output fans out to
 * every viewer and is kept as a backlog; input goes to a run's pane only from the person who
 * holds the run's driver lock (state.json, read at each write). Exits and idleness land in the
 * run's activity. Which panes exist, and how they start, is the layout's business (`Panes`).
 */
export class PtyBroker {
  private readonly live = new Map<string, Live>();

  constructor(private readonly d: PtyBrokerDependencies) {}

  /** Adopts a started terminal as the pane's; a dead entry of the same pane is replaced. */
  start(input: {
    readonly paneId: string;
    readonly runId?: string;
    readonly role: PaneRole;
    readonly host: string;
    readonly sessionId: string;
    readonly pty: PtyHandle;
  }): Result<PtyView, MetatorError> {
    const current = this.live.get(input.paneId);
    if (current?.alive) return err(MetatorError.usage(`pane ${input.paneId} already has a live terminal`));
    current?.cancelIdle?.();
    const entry: Live = {
      ...(input.runId ? { runId: input.runId } : {}),
      role: input.role,
      host: input.host,
      sessionId: input.sessionId,
      pty: input.pty,
      backlog: "",
      alive: true,
      idle: false,
      lastOutputAt: this.now(),
      listeners: new Set(),
    };
    this.live.set(input.paneId, entry);
    input.pty.onData((data) => {
      entry.backlog = (entry.backlog + data).slice(-BACKLOG_BYTES);
      entry.idle = false;
      entry.lastOutputAt = this.now();
      this.armIdle(input.paneId, entry);
      for (const l of entry.listeners) l({ type: "data", data });
    });
    input.pty.onExit((code) => {
      entry.alive = false;
      entry.exitCode = code;
      entry.cancelIdle?.();
      if (entry.runId)
        void this.d.journal.record(entry.runId, {
          type: "agent",
          origin: "pty",
          agent: entry.host,
          text: `session ${entry.sessionId} exited with ${code} (pane ${input.paneId})`,
        });
      for (const l of entry.listeners) l({ type: "exit", code });
    });
    this.armIdle(input.paneId, entry);
    return ok(this.view(input.paneId, entry));
  }

  /** Output since the terminal started (the last 200 kB), for a viewer that joins late. */
  backlog(paneId: string): string {
    return this.live.get(paneId)?.backlog ?? "";
  }

  subscribe(paneId: string, listener: (event: PtyEvent) => void): () => void {
    const entry = this.live.get(paneId);
    if (!entry) return () => {};
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  /**
   * Keystrokes from a person. A run's pane takes them only from the one who holds the run's
   * driver lock; a pane of no run (a shell) from anyone who gives a name.
   */
  async write(input: {
    readonly paneId: string;
    readonly data: string;
    readonly by: string;
  }): Promise<Result<void, MetatorError>> {
    const entry = this.live.get(input.paneId);
    if (!entry?.alive) return err(MetatorError.notFound(`a live terminal in pane ${input.paneId}`));
    if (entry.runId) {
      const record = await this.d.repo.load(entry.runId);
      if (record.isErr()) return err(record.error);
      const driver = record.value.driver;
      if (driver?.by !== "human" || driver.attachedBy !== input.by)
        return err(
          MetatorError.usage(
            driver?.by === "human"
              ? `run ${entry.runId} is driven by ${driver.attachedBy}: only they may type`
              : `run ${entry.runId} is driven by the agent: attach first (\`metator run attach --by ${input.by}\`)`,
          ),
        );
    } else if (input.by.trim() === "") return err(MetatorError.usage("say who types (`by`)"));
    entry.pty.write(input.data);
    return ok(undefined);
  }

  /** The supervisor's words to an idle session: typed only while the agent drives, never over a person. */
  async nudge(paneId: string, text: string): Promise<Result<void, MetatorError>> {
    const entry = this.live.get(paneId);
    if (!entry?.alive) return err(MetatorError.notFound(`a live terminal in pane ${paneId}`));
    if (entry.runId) {
      const record = await this.d.repo.load(entry.runId);
      if (record.isErr()) return err(record.error);
      if (record.value.driver?.by === "human")
        return err(
          MetatorError.usage(
            `run ${entry.runId} is driven by ${record.value.driver.attachedBy}: no nudge over a person`,
          ),
        );
    }
    entry.pty.write(`${text}\r`);
    entry.idle = false;
    this.armIdle(paneId, entry);
    return ok(undefined);
  }

  /**
   * A hook of the pane's session called in (`metator guard …` with the pane's token): the agent
   * works, whatever the screen shows. Idleness starts over.
   */
  heartbeat(paneId: string): Result<void, MetatorError> {
    const entry = this.live.get(paneId);
    if (!entry?.alive) return err(MetatorError.notFound(`a live terminal in pane ${paneId}`));
    entry.lastHookAt = this.now();
    entry.idle = false;
    this.armIdle(paneId, entry);
    return ok(undefined);
  }

  resize(paneId: string, size: PtySize): Result<void, MetatorError> {
    const entry = this.live.get(paneId);
    if (!entry?.alive) return err(MetatorError.notFound(`a live terminal in pane ${paneId}`));
    entry.pty.resize(size.cols, size.rows);
    return ok(undefined);
  }

  status(paneId: string): PtyView | undefined {
    const entry = this.live.get(paneId);
    return entry ? this.view(paneId, entry) : undefined;
  }

  list(): readonly PtyView[] {
    return [...this.live.entries()].map(([paneId, entry]) => this.view(paneId, entry));
  }

  /** The run's terminals, the conductor first. */
  byRun(runId: string): readonly PtyView[] {
    return this.list()
      .filter((v) => v.runId === runId)
      .sort((a, b) => Number(b.role === "conductor") - Number(a.role === "conductor"));
  }

  /** Ends the terminal (SIGHUP) and forgets it. */
  close(paneId: string): Result<{ readonly closed: boolean }, MetatorError> {
    const entry = this.live.get(paneId);
    if (!entry) return ok({ closed: false });
    entry.cancelIdle?.();
    if (entry.alive) entry.pty.kill();
    this.live.delete(paneId);
    return ok({ closed: true });
  }

  /** No output for `idleMs` while no question is open: the supervisor's cue to nudge. */
  private armIdle(paneId: string, entry: Live): void {
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
        if (entry.runId) {
          const questions = await this.d.journal.questions(entry.runId);
          if (questions.isOk() && questions.value.some((q) => !q.answer)) return;
        }
        entry.idle = true;
        if (entry.runId)
          await this.d.journal.record(entry.runId, {
            type: "idle",
            origin: "pty",
            agent: entry.host,
            text: `no output for ${Math.round(ms / 1000)} s and no open question (pane ${paneId})`,
          });
        for (const l of entry.listeners) l({ type: "idle" });
      })();
    });
  }

  private view(paneId: string, entry: Live): PtyView {
    return {
      paneId,
      ...(entry.runId ? { runId: entry.runId } : {}),
      role: entry.role,
      host: entry.host,
      sessionId: entry.sessionId,
      pid: entry.pty.pid,
      alive: entry.alive,
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
      idle: entry.idle,
      lastOutputAt: entry.lastOutputAt.toISOString(),
      ...(entry.lastHookAt ? { lastHookAt: entry.lastHookAt.toISOString() } : {}),
    };
  }

  private now(): Date {
    return this.d.clock?.now() ?? new Date();
  }
}
