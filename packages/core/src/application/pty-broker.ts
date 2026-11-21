import { MetatorError } from "../domain/errors.ts";
import type { PaneRole } from "../domain/layout.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock, PtyHandle, PtySize, ScreenModel, ScreenRenderer } from "../ports/index.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";

/** How much of a pane's output a late viewer gets. */
const BACKLOG_BYTES = 200_000;

/** The size a terminal is taken to have when its starter says none. */
const SCREEN_SIZE: PtySize = { cols: 120, rows: 40 };

/** How long after the nudge's words its Enter follows, so the two are not taken as one paste. */
export const NUDGE_ENTER_MS = 150;

export interface PtyBrokerDependencies {
  readonly repo: Pick<RunRepository, "load">;
  readonly journal: Pick<RunJournal, "record" | "questions">;
  /** No output for this long, and no open question, is idleness (SupervisorPolicy; default 90 s). */
  readonly idleMs?: number;
  /** Schedules a check (setTimeout); returns what cancels it. Injected so tests run without waiting. */
  readonly after?: (ms: number, fn: () => void) => () => void;
  /** Stamps output and hook calls (the pane sensor reads them); the wall clock by default. */
  readonly clock?: Clock;
  /** Draws each pane's screen as a person sees it (@xterm/headless); without it, the output without escapes. */
  readonly screens?: ScreenRenderer;
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
  /** What the terminal shows now, as a person sees it (the backlog holds every frame drawn). */
  readonly screen?: ScreenModel;
  alive: boolean;
  exitCode?: number;
  idle: boolean;
  lastOutputAt: Date;
  lastHookAt?: Date;
  cancelIdle?: () => void;
  readonly listeners: Set<(event: PtyEvent) => void>;
  /** The last few lines MetatorAI itself typed here (a nudge, a card's answer, a relay). */
  readonly typed: string[];
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
    /** The terminal's size, for the screen it shows. */
    readonly size?: PtySize;
    /** What the pane showed before (a resumed session): kept above the new output. */
    readonly backlog?: string;
  }): Result<PtyView, MetatorError> {
    const current = this.live.get(input.paneId);
    if (current?.alive) return err(MetatorError.usage(`pane ${input.paneId} already has a live terminal`));
    current?.cancelIdle?.();
    current?.screen?.dispose();
    const entry: Live = {
      ...(input.runId ? { runId: input.runId } : {}),
      role: input.role,
      host: input.host,
      sessionId: input.sessionId,
      pty: input.pty,
      backlog: (input.backlog ?? "").slice(-BACKLOG_BYTES),
      ...(this.d.screens ? { screen: this.d.screens.open(input.size ?? SCREEN_SIZE) } : {}),
      alive: true,
      idle: false,
      lastOutputAt: this.now(),
      listeners: new Set(),
      typed: [],
    };
    this.live.set(input.paneId, entry);
    if (input.backlog) entry.screen?.write(input.backlog);
    input.pty.onData((data) => {
      entry.backlog = (entry.backlog + data).slice(-BACKLOG_BYTES);
      entry.screen?.write(data);
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

  /**
   * What the pane's terminal shows, rendered as a person sees it (the last drawing of each line,
   * no escapes); undefined for a pane with no terminal here. The sensor reads prompts from it.
   */
  async screen(paneId: string): Promise<string | undefined> {
    const entry = this.live.get(paneId);
    return entry?.screen ? entry.screen.text() : undefined;
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
   * Keystrokes from a person. An agent's pane of a run takes them only from the one who holds the
   * run's driver lock; a shell pane (of a run or of none) from anyone who gives a name (S6): the
   * lock guards the agent's keyboard, not a person's own shell.
   */
  async write(input: {
    readonly paneId: string;
    readonly data: string;
    readonly by: string;
  }): Promise<Result<void, MetatorError>> {
    const entry = this.live.get(input.paneId);
    if (!entry?.alive) return err(MetatorError.notFound(`a live terminal in pane ${input.paneId}`));
    if (entry.runId && entry.role !== "shell") {
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

  /** MetatorAI typed this into the pane for someone (a card's answer): remembered like a nudge. */
  typedFor(paneId: string, text: string): void {
    const entry = this.live.get(paneId);
    if (!entry) return;
    entry.typed.push(text);
    if (entry.typed.length > 8) entry.typed.shift();
  }

  /** What MetatorAI typed into the pane lately: a host's hook that reports it is not the person talking. */
  daemonTyped(paneId: string): readonly string[] {
    return [...(this.live.get(paneId)?.typed ?? [])];
  }

  /** Whether a person holds the keyboard of the pane's run: nothing is typed over them. */
  private async held(entry: Live, what: string): Promise<Result<void, MetatorError>> {
    if (!entry.runId) return ok(undefined);
    const record = await this.d.repo.load(entry.runId);
    if (record.isErr()) return err(record.error);
    return record.value.driver?.by === "human"
      ? err(
          MetatorError.usage(
            `run ${entry.runId} is driven by ${record.value.driver.attachedBy}: no ${what} over a person`,
          ),
        )
      : ok(undefined);
  }

  /**
   * Stops what the pane's agent does and gives it words: Esc, the words a moment later, then
   * Enter as its own write (ADR-0093). Never over a person who holds the run's keyboard.
   */
  async interrupt(paneId: string, text: string): Promise<Result<void, MetatorError>> {
    const entry = this.live.get(paneId);
    if (!entry?.alive) return err(MetatorError.notFound(`a live terminal in pane ${paneId}`));
    const free = await this.held(entry, "interrupt");
    if (free.isErr()) return err(free.error);
    const after =
      this.d.after ??
      ((delay, fn) => {
        const t = setTimeout(fn, delay);
        return () => clearTimeout(t);
      });
    entry.pty.write("\x1b");
    this.typedFor(paneId, text);
    after(NUDGE_ENTER_MS, () => {
      if (!entry.alive) return;
      entry.pty.write(text);
      after(NUDGE_ENTER_MS, () => {
        if (entry.alive) entry.pty.write("\r");
      });
    });
    entry.idle = false;
    this.armIdle(paneId, entry);
    return ok(undefined);
  }

  /** The supervisor's words to an idle session: typed only while the agent drives, never over a person. */
  async nudge(paneId: string, text: string): Promise<Result<void, MetatorError>> {
    const entry = this.live.get(paneId);
    if (!entry?.alive) return err(MetatorError.notFound(`a live terminal in pane ${paneId}`));
    const free = await this.held(entry, "nudge");
    if (free.isErr()) return err(free.error);
    // The words, then Enter on its own a moment later: a terminal UI takes a burst of text that
    // ends in "\r" as a paste, and the Enter would land in the input instead of sending it.
    entry.pty.write(text);
    this.typedFor(paneId, text);
    const after =
      this.d.after ??
      ((delay, fn) => {
        const t = setTimeout(fn, delay);
        return () => clearTimeout(t);
      });
    after(NUDGE_ENTER_MS, () => {
      if (entry.alive) entry.pty.write("\r");
    });
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
    entry.screen?.resize(size);
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
  /** Stops the pane's process when it still lives; its screen and exit stay (an ended pane is read later). */
  stop(paneId: string): void {
    const entry = this.live.get(paneId);
    if (!entry?.alive) return;
    entry.cancelIdle?.();
    entry.pty.kill();
  }

  close(paneId: string): Result<{ readonly closed: boolean }, MetatorError> {
    const entry = this.live.get(paneId);
    if (!entry) return ok({ closed: false });
    entry.cancelIdle?.();
    // Closed, not ended: nobody listening hears the exit the kill causes.
    entry.listeners.clear();
    if (entry.alive) entry.pty.kill();
    entry.screen?.dispose();
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
