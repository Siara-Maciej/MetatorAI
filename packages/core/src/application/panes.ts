import type { AgentTask } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import type { PaneState, PaneStateView } from "../domain/host-manifest.ts";
import {
  addPane,
  addTab,
  addWorkspace,
  type Layout,
  type Pane,
  type PaneProcess,
  type PaneRole,
  paneOf,
  removePane,
  removeWorkspace,
  stripAnsi,
  tailLines,
  updatePane,
  type Workspace,
  workspaceOfRun,
} from "../domain/layout.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock, InteractiveHost, PtyHandle, PtySize, Terminal, Timer } from "../ports/index.ts";
import type { RunJournal } from "./drive.ts";
import type { LayoutStore } from "./layout-store.ts";
import type { PaneSensor } from "./pane-sensor.ts";
import type { PtyBroker, PtyView } from "./pty-broker.ts";
import type { RunRepository } from "./run-repository.ts";

export const DEFAULT_SIZE: PtySize = { cols: 120, rows: 36 };

export interface PanesDependencies {
  readonly layout: LayoutStore;
  readonly broker: PtyBroker;
  /** The interactive hosts in `supervisor.hostOrder`: the first is a new session's default. */
  readonly hosts: ReadonlyMap<string, InteractiveHost>;
  /** Spawns command panes (shells, logs). */
  readonly terminal: Terminal;
  readonly repo: RunRepository;
  readonly journal: Pick<RunJournal, "record">;
  readonly clock: Clock;
  readonly timer: Timer;
  /** Absolute repository root. */
  readonly root: string;
  /** Senses what each pane's agent is doing (R3); without it, panes report only alive and idle. */
  readonly sensor?: Pick<PaneSensor, "state">;
  /** A fresh pane token; random by default. */
  readonly token?: () => string;
}

/** A pane with its terminal's state, as clients see it. */
export interface PaneView extends Pane {
  readonly live?: PtyView;
  /** What the pane's agent is doing (R3), when the daemon senses it. */
  readonly state?: PaneStateView;
}

export interface LayoutView {
  readonly workspaces: readonly Workspace[];
  readonly panes: readonly PaneView[];
}

export interface OpenPaneInput {
  readonly workspace: string;
  readonly tab?: string;
  readonly role: PaneRole;
  readonly label?: string;
  /** Absolute; the workspace's directory when omitted. */
  readonly cwd?: string;
  readonly runId?: string;
  readonly worker?: Pane["worker"];
  readonly process:
    | {
        readonly kind: "host";
        readonly host?: string;
        readonly agent: string;
        readonly prompt: string;
        /** An earlier session of this host to continue instead of starting anew. */
        readonly sessionId?: string;
      }
    | { readonly kind: "command"; readonly argv: readonly string[] };
  readonly size?: PtySize;
}

/**
 * The daemon's workspaces and panes (R1, ADR-0080). It opens a workspace per run, starts a
 * host session or a command in a pane with the pane's identity in its environment, brings every
 * pane back after a restart, and closes panes and workspaces. The layout on disk is the only
 * memory; the broker holds the live terminals.
 */
export class Panes {
  /** Pane tokens, in memory only: a restarted daemon gives new ones to the panes it restarts. */
  private readonly tokens = new Map<string, string>();

  constructor(private readonly d: PanesDependencies) {}

  /** The run's workspace, made in its worktree (or the repository) when it has none. */
  async openWorkspace(input: {
    readonly runId?: string;
    readonly label?: string;
    readonly cwd?: string;
    readonly group?: string;
  }): Promise<Result<Workspace, MetatorError>> {
    let runId: string | undefined;
    let cwd = input.cwd ?? this.d.root;
    if (input.runId !== undefined) {
      const id = await this.d.repo.resolveId(input.runId);
      if (id.isErr()) return err(id.error);
      runId = id.value;
      const record = await this.d.repo.load(runId);
      if (record.isErr()) return err(record.error);
      cwd = record.value.worktree ? `${this.d.root}/${record.value.worktree.path}` : this.d.root;
    }
    const inWorktree = runId !== undefined && cwd !== this.d.root;
    return this.d.layout.update((layout) => {
      const existing = runId ? workspaceOfRun(layout, runId) : undefined;
      if (existing) return ok({ layout, value: existing });
      const at = this.d.clock.now().toISOString();
      // A run in its own worktree sits under the repository's workspace (R5), made when missing.
      let current = layout;
      let group = input.group;
      if (inWorktree && !group) {
        const repo = current.workspaces.find((w) => w.cwd === this.d.root && !w.runId);
        if (repo) group = repo.id;
        else {
          const made = addWorkspace(current, { label: basename(this.d.root), cwd: this.d.root, at });
          current = made.layout;
          group = made.workspace.id;
        }
      }
      const made = addWorkspace(current, {
        label: input.label ?? runId ?? basename(cwd),
        cwd,
        ...(runId ? { runId } : {}),
        ...(group ? { group } : {}),
        at,
      });
      return ok({ layout: made.layout, value: made.workspace });
    });
  }

  /** Closes the run's workspace with every pane in it (`run close`); nothing when it has none. */
  async closeRun(
    runId: string,
  ): Promise<Result<{ readonly closed: number; readonly workspace?: string }, MetatorError>> {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    const workspace = workspaceOfRun(layout.value, runId);
    if (!workspace) return ok({ closed: 0 });
    const closed = await this.closeWorkspace(workspace.id);
    if (closed.isErr()) return err(closed.error);
    return ok({ closed: closed.value.closed, workspace: workspace.id });
  }

  /** Another tab in a workspace. */
  async openTab(workspace: string, label: string): Promise<Result<string, MetatorError>> {
    return this.d.layout.update((layout) => {
      const made = addTab(layout, workspace, label);
      return made
        ? ok({ layout: made.layout, value: made.tab.id })
        : err(MetatorError.notFound(`workspace ${workspace}`));
    });
  }

  /** A pane with its process started; its record is in the layout before the process runs. */
  async openPane(input: OpenPaneInput): Promise<Result<PaneView, MetatorError>> {
    const hostId =
      input.process.kind === "host" ? (input.process.host ?? [...this.d.hosts.keys()][0]) : undefined;
    if (input.process.kind === "host" && (!hostId || !this.d.hosts.has(hostId)))
      return err(
        MetatorError.usage(
          `unknown interactive host ${hostId ?? "(none)"}`,
          `Hosts: ${[...this.d.hosts.keys()].join(", ") || "none"}.`,
        ),
      );
    const process: PaneProcess =
      input.process.kind === "host"
        ? {
            kind: "host",
            host: hostId as string,
            agent: input.process.agent,
            prompt: input.process.prompt,
            ...(input.process.sessionId ? { sessionId: input.process.sessionId } : {}),
          }
        : { kind: "command", argv: [...input.process.argv] };
    const added = await this.d.layout.update((layout) => {
      const workspace = layout.workspaces.find((w) => w.id === input.workspace);
      if (!workspace) return err(MetatorError.notFound(`workspace ${input.workspace}`));
      const runId = input.runId ?? workspace.runId;
      const made = addPane(layout, {
        workspace: input.workspace,
        ...(input.tab ? { tab: input.tab } : {}),
        role: input.role,
        label:
          input.label ??
          (input.process.kind === "host" ? input.process.agent : (input.process.argv[0] ?? "shell")),
        cwd: input.cwd ?? workspace.cwd,
        process,
        ...(runId ? { runId } : {}),
        ...(input.worker ? { worker: input.worker } : {}),
        at: this.d.clock.now().toISOString(),
      });
      return made
        ? ok({ layout: made.layout, value: made.pane })
        : err(MetatorError.notFound(`tab ${input.tab}`));
    });
    if (added.isErr()) return err(added.error);
    const started = await this.spawn(added.value, input.size ?? DEFAULT_SIZE);
    if (started.isErr()) {
      // A pane whose process never started is not kept: the next try makes a new one.
      await this.d.layout.update((layout) =>
        ok({ layout: removePane(layout, added.value.id), value: undefined }),
      );
      return err(started.error);
    }
    return ok(started.value);
  }

  /**
   * The run's conductor pane (D3's one session per run): its workspace made, the host started
   * with the run's task, or resumed by its session id when the pane's process ended.
   */
  async openRun(input: {
    readonly runId?: string;
    readonly host?: string;
    readonly agent?: string;
    /** The conductor's first message; the run's task when omitted. */
    readonly prompt?: string;
    readonly size?: PtySize;
  }): Promise<Result<PaneView, MetatorError>> {
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const runId = id.value;
    const record = await this.d.repo.load(runId);
    if (record.isErr()) return err(record.error);
    if (record.value.state.status !== "active")
      return err(
        MetatorError.usage(`run ${runId} is ${record.value.state.status}; there is no session to open`),
      );
    const workspace = await this.openWorkspace({ runId });
    if (workspace.isErr()) return err(workspace.error);
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    const conductor = layout.value.panes.find((p) => p.runId === runId && p.role === "conductor");
    if (conductor) {
      const live = this.d.broker.status(conductor.id);
      if (live?.alive) return ok({ ...conductor, live });
      return this.spawn(conductor, input.size ?? DEFAULT_SIZE);
    }
    const known = record.value.host && this.d.hosts.has(record.value.host) ? record.value.host : undefined;
    const host = input.host ?? known ?? [...this.d.hosts.keys()][0];
    // The run's earlier session on the same host continues (a closed pane, a `run drive` before).
    const sessionId = host !== undefined && record.value.host === host ? record.value.hostSession : undefined;
    return this.openPane({
      workspace: workspace.value.id,
      role: "conductor",
      label: input.agent ?? "session",
      runId,
      process: {
        kind: "host",
        ...(host ? { host } : {}),
        agent: input.agent ?? "session",
        prompt: input.prompt ?? record.value.task,
        ...(sessionId ? { sessionId } : {}),
      },
      ...(input.size ? { size: input.size } : {}),
    });
  }

  /** Every pane of the layout started again (after a daemon restart): sessions resumed, commands rerun. */
  async restore(
    size: PtySize = DEFAULT_SIZE,
  ): Promise<
    Result<
      readonly { readonly paneId: string; readonly ok: boolean; readonly error?: string }[],
      MetatorError
    >
  > {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    const out: { paneId: string; ok: boolean; error?: string }[] = [];
    for (const pane of layout.value.panes) {
      if (this.d.broker.status(pane.id)?.alive) continue;
      const started = await this.spawn(pane, size);
      out.push(
        started.isOk()
          ? { paneId: pane.id, ok: true }
          : { paneId: pane.id, ok: false, error: started.error.message },
      );
      if (started.isErr() && pane.runId)
        await this.d.journal.record(pane.runId, {
          type: "error",
          origin: "run",
          text: `pane ${pane.id} could not be restored: ${started.error.message}`,
        });
    }
    return ok(out);
  }

  /** The pane's terminal ended and the pane forgotten. */
  async closePane(paneId: string): Promise<Result<{ readonly closed: boolean }, MetatorError>> {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    const pane = paneOf(layout.value, paneId);
    const closed = this.d.broker.close(paneId);
    if (closed.isErr()) return err(closed.error);
    this.tokens.delete(paneId);
    if (!pane) return ok({ closed: closed.value.closed });
    const removed = await this.d.layout.update((l) =>
      ok({ layout: removePane(l, paneId), value: undefined }),
    );
    if (removed.isErr()) return err(removed.error);
    if (pane.runId) {
      const noted = await this.d.journal.record(pane.runId, {
        type: "agent",
        origin: "run",
        agent: pane.process.kind === "host" ? pane.process.host : pane.label,
        text: `closed pane ${paneId} (${pane.role}${pane.worker ? ` ${pane.worker.name}` : ""})`,
      });
      if (noted.isErr()) return err(noted.error);
    }
    return ok({ closed: true });
  }

  /** Every pane of the workspace closed, then the workspace forgotten. */
  async closeWorkspace(workspace: string): Promise<Result<{ readonly closed: number }, MetatorError>> {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    let closed = 0;
    for (const pane of layout.value.panes.filter((p) => p.tab.startsWith(`${workspace}:`))) {
      const r = await this.closePane(pane.id);
      if (r.isErr()) return err(r.error);
      closed++;
    }
    const removed = await this.d.layout.update((l) =>
      ok({ layout: removeWorkspace(l, workspace), value: undefined }),
    );
    if (removed.isErr()) return err(removed.error);
    return ok({ closed });
  }

  /** The pane a process speaks for, by the token in its environment; undefined for a stranger. */
  async authorize(token: string): Promise<Pane | undefined> {
    const paneId = [...this.tokens.entries()].find(([, t]) => t === token)?.[0];
    if (!paneId) return undefined;
    const layout = await this.d.layout.load();
    return layout.isOk() ? paneOf(layout.value, paneId) : undefined;
  }

  async view(): Promise<Result<LayoutView, MetatorError>> {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    return ok({
      workspaces: layout.value.workspaces,
      panes: await Promise.all(layout.value.panes.map((p) => this.withLive(p))),
    });
  }

  private async withLive(pane: Pane): Promise<PaneView> {
    const live = this.d.broker.status(pane.id);
    if (!live) return pane;
    const state = this.d.sensor ? await this.d.sensor.state(pane.id) : undefined;
    return { ...pane, live, ...(state?.isOk() ? { state: state.value } : {}) };
  }

  async pane(paneId: string): Promise<Result<PaneView, MetatorError>> {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    const pane = paneOf(layout.value, paneId);
    if (!pane) return err(MetatorError.notFound(`pane ${paneId}`));
    return ok(await this.withLive(pane));
  }

  /** The last lines of the pane's output, without terminal escapes. */
  read(paneId: string, lines = 80): string {
    return tailLines(stripAnsi(this.d.broker.backlog(paneId)), lines);
  }

  /**
   * Waits until the pane is in one of the states (polling), or the time is up. An exit ends the
   * wait whatever was asked for. `idle` and `exited` come from the broker; `blocked`, `waiting`
   * and `working` need the sensor.
   */
  async wait(
    paneId: string,
    input: { readonly until: readonly PaneState[]; readonly timeoutMs: number; readonly pollMs?: number },
  ): Promise<
    Result<
      { readonly state: PaneState | "timeout"; readonly exitCode?: number; readonly reason?: string },
      MetatorError
    >
  > {
    const deadline = this.d.clock.now().getTime() + input.timeoutMs;
    for (;;) {
      const live = this.d.broker.status(paneId);
      if (!live) return err(MetatorError.notFound(`a terminal in pane ${paneId}`));
      if (!live.alive)
        return ok({ state: "exited", ...(live.exitCode !== undefined ? { exitCode: live.exitCode } : {}) });
      if (live.idle && input.until.includes("idle")) return ok({ state: "idle" });
      const sensed = this.d.sensor ? await this.d.sensor.state(paneId) : undefined;
      if (sensed?.isOk() && input.until.includes(sensed.value.state))
        return ok({ state: sensed.value.state, reason: sensed.value.reason });
      if (this.d.clock.now().getTime() >= deadline) return ok({ state: "timeout" });
      await this.d.timer.sleep(input.pollMs ?? 200);
    }
  }

  /** Starts the pane's process with the pane's identity in its environment; a host session with an id resumes. */
  private async spawn(pane: Pane, size: PtySize): Promise<Result<PaneView, MetatorError>> {
    const token = (this.d.token ?? (() => crypto.randomUUID()))();
    const env = {
      METATOR_PANE_ID: pane.id,
      METATOR_PANE_TOKEN: token,
      METATOR_ROLE: pane.role,
      ...(pane.worker ? { METATOR_WORKER: pane.worker.name } : {}),
    };
    let pty: PtyHandle;
    let sessionId: string;
    let host = pane.label;
    let resumed = false;
    if (pane.process.kind === "host") {
      const h = this.d.hosts.get(pane.process.host);
      if (!h) return err(MetatorError.usage(`unknown interactive host ${pane.process.host}`));
      host = h.id;
      const runDir = pane.runId
        ? `${pane.cwd}/${this.d.repo.runDir(pane.runId)}`
        : `${pane.cwd}/.metator/panes/${pane.id}`;
      const task: AgentTask = {
        agent: pane.process.agent,
        prompt: pane.process.prompt,
        cwd: pane.cwd,
        projectRoot: this.d.root,
        runDir,
        driven: true,
        env,
      };
      const previous = pane.process.sessionId;
      const started = previous ? await h.resume(previous, task, size) : await h.start(task, size);
      if (started.isErr()) return err(started.error);
      pty = started.value.pty;
      sessionId = started.value.sessionId;
      resumed = previous !== undefined;
    } else {
      const spawned = this.d.terminal.spawn(pane.process.argv, { cwd: pane.cwd, env, size });
      if (spawned.isErr()) return err(spawned.error);
      pty = spawned.value;
      sessionId = `${pane.id}:${pty.pid}`;
    }
    const adopted = this.d.broker.start({
      paneId: pane.id,
      ...(pane.runId ? { runId: pane.runId } : {}),
      role: pane.role,
      host,
      sessionId,
      pty,
    });
    if (adopted.isErr()) {
      pty.kill();
      return err(adopted.error);
    }
    this.tokens.set(pane.id, token);
    const saved = await this.d.layout.update((layout) => {
      const updated = updatePane(layout, pane.id, (p) =>
        p.process.kind === "host" ? { ...p, process: { ...p.process, sessionId } } : p,
      );
      return ok({ layout: updated, value: paneOf(updated, pane.id) });
    });
    if (saved.isErr()) return err(saved.error);
    if (pane.runId) {
      // The conductor's session is the run's host session too (`run drive` resumes it).
      if (pane.role === "conductor" && pane.process.kind === "host") {
        const record = await this.d.repo.load(pane.runId);
        if (record.isOk())
          await this.d.repo.save({
            ...record.value,
            host,
            hostSession: sessionId,
            updatedAt: this.d.clock.now().toISOString(),
          });
      }
      const noted = await this.d.journal.record(pane.runId, {
        type: "agent",
        origin: "pty",
        agent: host,
        text: `${resumed ? "resumed" : "started"} session ${sessionId} in pane ${pane.id} (pid ${pty.pid}${pane.worker ? `, worker ${pane.worker.name}` : ""})`,
      });
      if (noted.isErr()) return err(noted.error);
    }
    const current = saved.value ?? pane;
    return ok({ ...current, live: adopted.value });
  }
}

/** The layout a client renders: workspaces with their panes nested, the live state on each. */
export function layoutTree(
  view: LayoutView,
): readonly (Workspace & { readonly panes: readonly PaneView[] })[] {
  const byWorkspace = new Map<string, PaneView[]>();
  for (const p of view.panes) {
    const w = p.tab.split(":")[0] as string;
    byWorkspace.set(w, [...(byWorkspace.get(w) ?? []), p]);
  }
  return view.workspaces.map((w) => ({ ...w, panes: byWorkspace.get(w.id) ?? [] }));
}

export const isLayout = (x: unknown): x is Layout => typeof x === "object" && x !== null && "workspaces" in x;

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
