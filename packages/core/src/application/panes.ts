import type { AgentTask } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import type { PaneState, PaneStateView } from "../domain/host-manifest.ts";
import {
  addPane,
  addTab,
  addWorkspace,
  isPlainShell,
  type Pane,
  type PaneEndReason,
  type PanePauseReason,
  type PaneProcess,
  type PaneRole,
  paneOf,
  removePane,
  removeWorkspace,
  type SplitNode,
  stripAnsi,
  type Tab,
  tailLines,
  treeFits,
  updatePane,
  type Workspace,
  workspaceOfPane,
  workspaceOfRun,
} from "../domain/layout.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type {
  Clock,
  FileSystem,
  InteractiveHost,
  PtyHandle,
  PtySize,
  Terminal,
  Timer,
} from "../ports/index.ts";
import type { LayoutStore } from "./layout-store.ts";
import type { PaneSensor } from "./pane-sensor.ts";
import type { PtyBroker, PtyView } from "./pty-broker.ts";
import type { RunJournal } from "./run-journal.ts";
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
  /** Where an ended pane's last screen is kept (`.metator/panes/`), so it can be read after a restart. */
  readonly fs?: Pick<FileSystem, "write" | "read" | "exists" | "remove">;
}

/** Why and when a pane's work ended, as `end` is told it. */
export interface PaneEnd {
  readonly reason: PaneEndReason;
  readonly exitCode?: number;
  readonly summary?: string;
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
  /** Beside this pane of the same tab, in this direction (S6); the tab is the target's then. */
  readonly split?: { readonly target: string; readonly dir: "row" | "column" };
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
/**
 * What an agent opened from "+ New session" is told (T1, design/14 §2): a person talks to it before
 * any run exists; it answers questions about the repository and starts a run only for a task.
 */
export const INTAKE_PROMPT =
  "You are MetatorAI's entry point: a person is talking to you before any run exists. Answer questions about this repository with file:line citations; when the person asks for a change, ask only what the repository cannot tell you, then start the run from this pane (`metator run init`, then `metator run drive --detach`) and say its id. The child runs a system plan starts open as their own conductor sessions: never drive those.";

export class Panes {
  /** Pane tokens, in memory only: a restarted daemon gives new ones to the panes it restarts. */
  private readonly tokens = new Map<string, string>();
  /** Ended panes' last screens read back from disk. */
  private readonly kept = new Map<string, string>();
  /** The daemon is shutting down: a session whose process goes now is paused, not ended. */
  private stopping = false;

  constructor(private readonly d: PanesDependencies) {}

  /**
   * The daemon stops (SIGTERM, SIGINT): every live host session is paused with its session id and
   * last screen, before its process goes with the daemon (ADR-0092). The exits that follow find
   * the panes paused and leave them so; the next start resumes them in the same panes.
   */
  async pauseAll(
    why: PanePauseReason = "daemon-stopped",
  ): Promise<Result<{ readonly paused: number }, MetatorError>> {
    this.stopping = true;
    const saved = await this.saveScreens();
    if (saved.isErr()) return err(saved.error);
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    let paused = 0;
    for (const pane of layout.value.panes) {
      if (pane.process.kind !== "host" || pane.ended || !this.d.broker.status(pane.id)?.alive) continue;
      const r = await this.pause(pane.id, why);
      if (r.isErr()) return err(r.error);
      if (r.value.paused) paused++;
    }
    return ok({ paused });
  }

  /**
   * A host pane whose process is gone while its work is not over: paused, its session id and last
   * screen kept, to be resumed in the same pane. A pane whose work ended stays ended.
   */
  async pause(
    paneId: string,
    why: PanePauseReason,
  ): Promise<Result<{ readonly paused: boolean }, MetatorError>> {
    const at = this.d.clock.now().toISOString();
    const marked = await this.d.layout.update((l) => {
      const pane = paneOf(l, paneId);
      if (!pane || pane.ended || pane.paused || pane.process.kind !== "host")
        return ok({ layout: l, value: undefined });
      return ok({ layout: updatePane(l, paneId, (p) => ({ ...p, paused: { at, why } })), value: pane });
    });
    if (marked.isErr()) return err(marked.error);
    const pane = marked.value;
    if (!pane) return ok({ paused: false });
    const kept = await this.keepScreen(paneId);
    if (kept.isErr()) return err(kept.error);
    if (pane.runId) {
      const noted = await this.d.journal.record(pane.runId, {
        type: "agent",
        origin: "run",
        agent: pane.process.kind === "host" ? pane.process.host : pane.label,
        text:
          pane.process.kind === "host" && pane.process.sessionId
            ? `pane ${paneId} paused (${why}): session ${pane.process.sessionId} can be continued`
            : `pane ${paneId} paused (${why})`,
      });
      if (noted.isErr()) return err(noted.error);
    }
    return ok({ paused: true });
  }

  /** Every live pane's screen kept on disk (the daemon does it every few seconds): a SIGKILL loses little. */
  async saveScreens(): Promise<Result<{ readonly saved: number }, MetatorError>> {
    let saved = 0;
    for (const live of this.d.broker.list()) {
      if (!live.alive) continue;
      const kept = await this.keepScreen(live.paneId);
      if (kept.isErr()) return err(kept.error);
      saved++;
    }
    return ok({ saved });
  }

  private async keepScreen(paneId: string): Promise<Result<void, MetatorError>> {
    const screen = this.d.broker.backlog(paneId);
    if (!screen || !this.d.fs) return ok(undefined);
    this.kept.set(paneId, screen);
    return this.d.fs.write(screenFile(paneId), screen);
  }

  /**
   * A paused pane (or one that died with the daemon) started again in the same pane: its host
   * session resumed by its id, its last screen shown above what the session prints now.
   */
  async resumePane(paneId: string, size: PtySize = DEFAULT_SIZE): Promise<Result<PaneView, MetatorError>> {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    const pane = paneOf(layout.value, paneId);
    if (!pane) return err(MetatorError.notFound(`pane ${paneId}`));
    if (this.d.broker.status(paneId)?.alive) return ok(await this.withLive(pane));
    if (pane.ended)
      return err(
        MetatorError.usage(`pane ${paneId} has ended (${pane.ended.reason}): there is nothing to continue`),
      );
    if (pane.process.kind !== "host")
      return err(MetatorError.usage(`pane ${paneId} runs a command: it is not continued`));
    return this.spawn(pane, size, await this.keptScreen(paneId));
  }

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
      // A run has one workspace; so has a label without a run (the "intake" workspace, T1).
      const existing = runId
        ? workspaceOfRun(layout, runId)
        : input.label
          ? layout.workspaces.find((w) => !w.runId && w.label === input.label && w.cwd === cwd)
          : undefined;
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

  /**
   * The panes of every run that is done or aborted, ended (conductor and workers): a living
   * process is stopped and the pane says why, its last screen kept. Nothing is removed: a person
   * closes ended panes. A finished run's idle conductor no longer reads as a session that waits.
   */
  async endFinished(): Promise<Result<{ readonly runId: string; readonly ended: number }[], MetatorError>> {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    const runIds = [...new Set(layout.value.panes.flatMap((p) => (p.runId && !p.ended ? [p.runId] : [])))];
    const out: { runId: string; ended: number }[] = [];
    for (const runId of runIds) {
      const record = await this.d.repo.load(runId);
      if (record.isErr() || (record.value.state.status !== "done" && record.value.state.status !== "aborted"))
        continue;
      let ended = 0;
      for (const pane of layout.value.panes.filter((p) => p.runId === runId && !p.ended)) {
        const r = await this.end(pane.id, { reason: "run-finished" });
        if (r.isErr()) return err(r.error);
        if (r.value.ended) ended++;
      }
      if (ended > 0) out.push({ runId, ended });
    }
    return ok(out);
  }

  /**
   * The pane's work is over: it says why and when, its process is stopped if it still lives, and
   * its last screen is kept to read. A pane that already ended keeps why, unless `override` (a
   * collected worker says it was collected, with its summary, after its process exited).
   */
  async end(
    paneId: string,
    input: PaneEnd & { readonly override?: boolean },
  ): Promise<Result<{ readonly ended: boolean }, MetatorError>> {
    const at = this.d.clock.now().toISOString();
    const marked = await this.d.layout.update((l) => {
      const pane = paneOf(l, paneId);
      if (!pane || (pane.ended && !input.override)) return ok({ layout: l, value: undefined });
      // A paused pane's process exiting (it went with the daemon) is no end of its work.
      if (pane.paused && input.reason === "exited") return ok({ layout: l, value: undefined });
      const ended = {
        at,
        reason: input.reason,
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
      };
      return ok({
        layout: updatePane(l, paneId, (p) => {
          const { paused: _resumable, ...rest } = p;
          return { ...rest, ended };
        }),
        value: pane,
      });
    });
    if (marked.isErr()) return err(marked.error);
    const pane = marked.value;
    if (!pane) return ok({ ended: false });
    // Marked first: the exit the stop causes finds the pane ended already, and keeps why.
    this.d.broker.stop(paneId);
    const screen = this.d.broker.backlog(paneId);
    if (screen && this.d.fs) {
      const kept = await this.d.fs.write(screenFile(paneId), screen);
      if (kept.isErr()) return err(kept.error);
    }
    // An exit is in the run's activity already (the broker says it): only other ends are said.
    if (pane.runId && input.reason !== "exited") {
      const noted = await this.d.journal.record(pane.runId, {
        type: "agent",
        origin: "run",
        agent: pane.process.kind === "host" ? pane.process.host : pane.label,
        text: `pane ${paneId} ended (${input.reason}${input.exitCode !== undefined ? ` ${input.exitCode}` : ""})${input.summary ? `: ${input.summary}` : ""}`,
      });
      if (noted.isErr()) return err(noted.error);
    }
    return ok({ ended: true });
  }

  /** The run a pane's agent started (`run new` from the chat where a person gave the task): that task's main terminal. */
  async setStartedRun(paneId: string, runId: string): Promise<Result<Pane, MetatorError>> {
    const saved = await this.d.layout.update((l) => {
      if (!paneOf(l, paneId)) return err(MetatorError.notFound(`pane ${paneId}`));
      const updated = updatePane(l, paneId, (p) => ({ ...p, startedRun: runId }));
      return ok({ layout: updated, value: paneOf(updated, paneId) as Pane });
    });
    return saved;
  }

  /** Every ended pane closed (of one run, when named): what a person clears in one go. */
  async closeEnded(input: {
    readonly runId?: string;
  }): Promise<Result<{ readonly closed: number }, MetatorError>> {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    let closed = 0;
    for (const pane of layout.value.panes.filter(
      (p) => p.ended && (!input.runId || p.runId === input.runId),
    )) {
      const r = await this.closePane(pane.id);
      if (r.isErr()) return err(r.error);
      if (r.value.closed) closed++;
    }
    return ok({ closed });
  }

  /** A pane's screen as printed: its live backlog, or an ended pane's kept last screen. */
  screen(paneId: string): string {
    return this.d.broker.backlog(paneId) || this.kept.get(paneId) || "";
  }

  /** The kept last screen of an ended pane, read from disk (after a restart). */
  async keptScreen(paneId: string): Promise<string> {
    const live = this.screen(paneId);
    if (live || !this.d.fs) return live;
    if (!(await this.d.fs.exists(screenFile(paneId)))) return "";
    const text = await this.d.fs.read(screenFile(paneId));
    if (text.isOk()) this.kept.set(paneId, text.value);
    return text.isOk() ? text.value : "";
  }

  /**
   * The pane's area split in two (S6): a new pane (a shell by default) takes the second half,
   * and the tab's tree remembers it. `right` puts it beside, `down` below.
   */
  async splitPane(
    paneId: string,
    input: {
      readonly dir: "right" | "down";
      readonly process?: OpenPaneInput["process"];
      readonly label?: string;
      readonly size?: PtySize;
    },
  ): Promise<Result<PaneView, MetatorError>> {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    const pane = paneOf(layout.value, paneId);
    if (!pane) return err(MetatorError.notFound(`pane ${paneId}`));
    return this.openPane({
      workspace: workspaceOfPane(pane),
      tab: pane.tab,
      role: input.process && input.process.kind === "host" ? "apps" : "shell",
      ...(input.label ? { label: input.label } : {}),
      cwd: pane.cwd,
      process: input.process ?? { kind: "command", argv: ["sh"] },
      split: { target: paneId, dir: input.dir === "right" ? "row" : "column" },
      ...(input.size ? { size: input.size } : {}),
    });
  }

  /** A tab's split tree as a client arranged it (ratios, drags); its leaves must be the tab's panes. */
  async setTree(tabId: string, tree: SplitNode): Promise<Result<Tab, MetatorError>> {
    return this.d.layout.update((layout) => {
      const workspace = layout.workspaces.find((w) => w.tabs.some((t) => t.id === tabId));
      const tab = workspace?.tabs.find((t) => t.id === tabId);
      if (!workspace || !tab) return err(MetatorError.notFound(`tab ${tabId}`));
      if (!treeFits(tree, tab.panes))
        return err(
          MetatorError.usage(
            `the tree's panes are not tab ${tabId}'s panes (${tab.panes.join(", ")})`,
            "Send a tree whose leaves are exactly the tab's panes.",
          ),
        );
      const next = { ...tab, tree };
      return ok({
        layout: {
          ...layout,
          workspaces: layout.workspaces.map((w) =>
            w.id === workspace.id ? { ...w, tabs: w.tabs.map((t) => (t.id === tabId ? next : t)) } : w,
          ),
        },
        value: next,
      });
    });
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
            // A host pane with no task yet is the entry point: it gets the intake prompt.
            prompt: input.process.prompt || INTAKE_PROMPT,
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
          (input.process.kind === "host" ? input.process.agent : basename(input.process.argv[0] ?? "shell")),
        cwd: input.cwd ?? workspace.cwd,
        process,
        ...(runId ? { runId } : {}),
        ...(input.worker ? { worker: input.worker } : {}),
        ...(input.split ? { split: input.split } : {}),
        at: this.d.clock.now().toISOString(),
      });
      return made
        ? ok({ layout: made.layout, value: made.pane })
        : err(MetatorError.notFound(input.split ? `pane ${input.split.target}` : `tab ${input.tab}`));
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

  /**
   * The layout's panes started again (after a daemon restart): host sessions resumed and plain
   * shells opened. A pane that ran a command stays as it ended (the command is not run a second
   * time, R11), and so does the session of a run that is no longer active; each says why in `skipped`.
   */
  async restore(
    size: PtySize = DEFAULT_SIZE,
    /** false (`metator serve --no-restore`): host sessions stay paused until a person continues them. */
    options: { readonly resume?: boolean } = {},
  ): Promise<
    Result<
      readonly {
        readonly paneId: string;
        readonly ok: boolean;
        readonly error?: string;
        readonly skipped?: string;
      }[],
      MetatorError
    >
  > {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    const out: { paneId: string; ok: boolean; error?: string; skipped?: string }[] = [];
    for (const pane of layout.value.panes) {
      if (this.d.broker.status(pane.id)?.alive) continue;
      const skipped = await this.notRestored(pane);
      if (skipped) {
        out.push({ paneId: pane.id, ok: false, skipped });
        continue;
      }
      if (pane.process.kind === "host" && options.resume === false) {
        // Went with the daemon (a SIGKILL leaves it looking live): paused until it is continued.
        const paused = await this.pause(pane.id, pane.paused?.why ?? "daemon-stopped");
        if (paused.isErr()) return err(paused.error);
        out.push({ paneId: pane.id, ok: false, skipped: "paused: `metator run continue` resumes it" });
        continue;
      }
      // A host session resumed in its pane, with the screen it left; a shell starts afresh.
      const previous = pane.process.kind === "host" ? await this.keptScreen(pane.id) : undefined;
      const started = await this.spawn(pane, size, previous);
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

  /** Why a pane is not started again by itself; undefined when it is. */
  private async notRestored(pane: Pane): Promise<string | undefined> {
    if (pane.ended) return `its work ended (${pane.ended.reason})`;
    if (pane.process.kind === "command")
      return isPlainShell(pane.process.argv)
        ? undefined
        : `its command is not run a second time: ${pane.process.argv.join(" ")}`;
    if (!pane.runId) return undefined;
    const record = await this.d.repo.load(pane.runId);
    return record.isOk() && record.value.state.status !== "active"
      ? `run ${pane.runId} is ${record.value.state.status}: its session is not started again`
      : undefined;
  }

  /** The pane's terminal ended and the pane forgotten. */
  async closePane(paneId: string): Promise<Result<{ readonly closed: boolean }, MetatorError>> {
    const layout = await this.d.layout.load();
    if (layout.isErr()) return err(layout.error);
    const pane = paneOf(layout.value, paneId);
    const closed = this.d.broker.close(paneId);
    if (closed.isErr()) return err(closed.error);
    this.tokens.delete(paneId);
    // Its kept screen goes with it: a pane given the same id later starts with a clean screen.
    this.kept.delete(paneId);
    if (this.d.fs && (await this.d.fs.exists(screenFile(paneId)))) {
      const forgot = await this.d.fs.remove(screenFile(paneId));
      if (forgot.isErr()) return err(forgot.error);
    }
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

  /** The last lines of the pane's screen as a person sees it (rendered; a kept screen without escapes). */
  async read(paneId: string, lines = 80): Promise<string> {
    return tailLines((await this.d.broker.screen(paneId)) ?? stripAnsi(this.screen(paneId)), lines);
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
  private async spawn(
    pane: Pane,
    size: PtySize,
    previousScreen?: string,
  ): Promise<Result<PaneView, MetatorError>> {
    const token = (this.d.token ?? (() => crypto.randomUUID()))();
    const env = {
      METATOR_PANE_ID: pane.id,
      METATOR_PANE_TOKEN: token,
      METATOR_ROLE: pane.role,
      ...(pane.worker ? { METATOR_WORKER: pane.worker.name } : {}),
    };
    let pty: PtyHandle;
    let sessionId: string;
    // A command pane's "host" is its program, as a host id (`/bin/bash` → `bash`).
    let host = hostIdOf(pane.label);
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
      size,
      // A session resumed in its pane: the screen it left is shown above what it prints now.
      ...(previousScreen ? { backlog: `${previousScreen}\r\n` } : {}),
    });
    if (adopted.isErr()) {
      pty.kill();
      return err(adopted.error);
    }
    this.tokens.set(pane.id, token);
    // Started (again): its work is not over.
    const saved = await this.d.layout.update((layout) => {
      const updated = updatePane(layout, pane.id, (p) => {
        const { ended: _over, paused: _resumed, ...open } = p;
        return open.process.kind === "host" ? { ...open, process: { ...open.process, sessionId } } : open;
      });
      return ok({ layout: updated, value: paneOf(updated, pane.id) });
    });
    if (saved.isErr()) return err(saved.error);
    // The process exits: the pane says so, with the code, and stays until a person closes it. A
    // host session that goes with the daemon, or that a signal ended, is paused instead: its work
    // is not over, and it is continued in the same pane.
    this.d.broker.subscribe(pane.id, (event) => {
      if (event.type !== "exit") return;
      if (pane.process.kind === "host" && (this.stopping || event.code >= SIGNALLED))
        void this.pause(pane.id, this.stopping ? "daemon-stopped" : "process-lost");
      else void this.end(pane.id, { reason: "exited", exitCode: event.code });
    });
    if (pane.runId) {
      // The conductor's session is the run's host session too (`run drive` resumes it).
      if (pane.role === "conductor" && pane.process.kind === "host") {
        const at = this.d.clock.now().toISOString();
        await this.d.repo.update(pane.runId, (record) =>
          ok({ ...record, host, hostSession: sessionId, updatedAt: at }),
        );
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

/** An exit code at or above this is a process a signal ended (128 + the signal). */
const SIGNALLED = 128;

/** Where an ended pane's last screen is kept. */
const screenFile = (paneId: string): string => `.metator/panes/${paneId.replaceAll(":", "-")}.screen`;

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";

/** A label as a host id: lowercase letters, digits and dashes, starting with a letter. */
export function hostIdOf(label: string): string {
  const id = basename(label)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
  return id === "" ? "shell" : id;
}
