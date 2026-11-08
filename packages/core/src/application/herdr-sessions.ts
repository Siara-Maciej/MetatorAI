import type { AgentTask } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import {
  type HerdrBinding,
  HerdrBindingDocument,
  type HerdrWorkspace,
  HerdrWorkspacesDocument,
  herdrTitle,
  shellLine,
} from "../domain/herdr.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem, HerdrControl, InteractiveHost, MachineState } from "../ports/index.ts";
import type { RunJournal } from "./drive.ts";
import type { WorkOverview } from "./overview.ts";
import type { RunRepository } from "./run-repository.ts";

export interface HerdrSessionsDependencies {
  readonly repo: RunRepository;
  readonly journal: Pick<RunJournal, "record" | "activity">;
  /** The interactive hosts, in `supervisor.hostOrder`: the first is a new session's default. */
  readonly hosts: ReadonlyMap<string, InteractiveHost>;
  readonly control: HerdrControl;
  readonly fs: FileSystem;
  readonly clock: Clock;
  /** Absolute repository root. */
  readonly root: string;
  readonly overview: Pick<WorkOverview, "execute">;
  /** The machine-wide index of workspaces (for herdr's plugin), and herdr's session name. */
  readonly machine?: MachineState;
  readonly session?: string;
}

/** The machine-wide index's document name. */
export const HERDR_WORKSPACES = "herdr-workspaces.json";

export interface HerdrOpened extends HerdrBinding {
  readonly runId: string;
  /** The pane was already there: nothing was started. */
  readonly reused: boolean;
  /** The host continued its earlier session instead of starting one. */
  readonly resumed: boolean;
}

export interface HerdrSync {
  readonly runId: string;
  readonly pane: string;
  readonly alive: boolean;
  readonly agentStatus?: string;
  readonly title?: string;
}

/** What the activity says when herdr sees the host stopped at a prompt MetatorAI did not ask. */
export const HOST_PROMPT = (pane: string) =>
  `the host waits at its own prompt in herdr pane ${pane}; answer it there (a person, not another agent)`;

/**
 * Runs' host sessions in herdr (E2, ADR-0079). herdr owns the terminals, the layout and the
 * windows; MetatorAI opens a workspace per run, starts the host there with the run's flags and
 * variables (its hooks then guard every tool call), mirrors the run's stage into herdr's sidebar,
 * and notes in the run's activity when herdr sees the host stopped at a prompt of its own.
 */
export class HerdrSessions {
  constructor(private readonly d: HerdrSessionsDependencies) {}

  async open(input: {
    readonly runId?: string;
    readonly host?: string;
  }): Promise<Result<HerdrOpened, MetatorError>> {
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const runId = id.value;
    const record = await this.d.repo.load(runId);
    if (record.isErr()) return err(record.error);
    if (record.value.state.status !== "active")
      return err(
        MetatorError.usage(`run ${runId} is ${record.value.state.status}; there is no session to open`),
      );
    const bound = await this.binding(runId);
    if (bound.isErr()) return err(bound.error);
    if (bound.value) {
      const status = await this.d.control.status(bound.value.pane);
      if (status.isErr()) return err(status.error);
      if (status.value.exists) return ok({ runId, ...bound.value, reused: true, resumed: false });
    }
    const known = record.value.host && this.d.hosts.has(record.value.host) ? record.value.host : undefined;
    const hostId = input.host ?? known ?? [...this.d.hosts.keys()][0];
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
    const resume = record.value.host === host.id ? record.value.hostSession : undefined;
    const launch = await host.launch(task, resume);
    if (launch.isErr()) return err(launch.error);
    const opened = await this.d.control.open({ cwd, label: runId, env: launch.value.env });
    if (opened.isErr()) return err(opened.error);
    const ran = await this.d.control.run(opened.value.pane, shellLine(launch.value.argv));
    if (ran.isErr()) return err(ran.error);
    const now = this.d.clock.now().toISOString();
    const binding: HerdrBinding = {
      workspace: opened.value.workspace,
      pane: opened.value.pane,
      host: host.id,
      sessionId: launch.value.sessionId,
      openedAt: now,
    };
    const written = await this.d.fs.write(
      this.file(runId),
      serializeJsonDocument(HerdrBindingDocument.stamp(binding)),
    );
    if (written.isErr()) return err(written.error);
    const saved = await this.d.repo.save({
      ...record.value,
      host: host.id,
      hostSession: launch.value.sessionId,
      updatedAt: now,
    });
    if (saved.isErr()) return err(saved.error);
    const indexed = await this.index((entries) => [
      ...entries.filter((e) => !(e.session === this.session && e.workspace === binding.workspace)),
      { session: this.session, workspace: binding.workspace, root: this.d.root, runId },
    ]);
    if (indexed.isErr()) return err(indexed.error);
    const recorded = await this.d.journal.record(runId, {
      type: "agent",
      origin: "run",
      agent: host.id,
      text: `${resume ? "resumed" : "started"} session ${launch.value.sessionId} in herdr pane ${binding.pane} (workspace ${binding.workspace})`,
    });
    if (recorded.isErr()) return err(recorded.error);
    return ok({ runId, ...binding, reused: false, resumed: resume !== undefined });
  }

  /**
   * Each active run bound to a pane: herdr's view of it, the run's stage written to herdr's sidebar,
   * and a note in the run's activity, once, when herdr sees the host blocked at a prompt that is
   * not a MetatorAI question.
   */
  async sync(): Promise<Result<readonly HerdrSync[], MetatorError>> {
    const overview = await this.d.overview.execute();
    if (overview.isErr()) return err(overview.error);
    const out: HerdrSync[] = [];
    for (const run of overview.value.runs) {
      if (run.status !== "active") continue;
      const bound = await this.binding(run.runId);
      if (bound.isErr()) return err(bound.error);
      if (!bound.value) continue;
      const pane = bound.value.pane;
      const status = await this.d.control.status(pane);
      if (status.isErr()) return err(status.error);
      if (!status.value.exists) {
        out.push({ runId: run.runId, pane, alive: false });
        continue;
      }
      const title = herdrTitle({
        stage: run.stage,
        attention: run.attention,
        questions: run.questions.length,
      });
      const reported = await this.d.control.report(pane, {
        title,
        tokens: { run: run.runId, stage: run.stage, waiting: String(run.questions.length) },
      });
      if (reported.isErr()) return err(reported.error);
      if (status.value.agentStatus === "blocked" && run.questions.length === 0) {
        const note = HOST_PROMPT(pane);
        const activity = await this.d.journal.activity(run.runId);
        if (activity.isErr()) return err(activity.error);
        if (activity.value.at(-1)?.text !== note) {
          const recorded = await this.d.journal.record(run.runId, {
            type: "idle",
            origin: "pty",
            text: note,
          });
          if (recorded.isErr()) return err(recorded.error);
        }
      }
      out.push({
        runId: run.runId,
        pane,
        alive: true,
        ...(status.value.agentStatus ? { agentStatus: status.value.agentStatus } : {}),
        title,
      });
    }
    return ok(out);
  }

  /** Closes the run's herdr workspace (its processes end) and forgets the binding. */
  async close(input: {
    readonly runId?: string;
  }): Promise<Result<{ readonly runId: string; readonly closed: boolean }, MetatorError>> {
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const bound = await this.binding(id.value);
    if (bound.isErr()) return err(bound.error);
    if (!bound.value) return ok({ runId: id.value, closed: false });
    const status = await this.d.control.status(bound.value.pane);
    if (status.isErr()) return err(status.error);
    if (status.value.exists) {
      const closed = await this.d.control.close(bound.value.workspace);
      if (closed.isErr()) return err(closed.error);
    }
    const removed = await this.d.fs.remove(this.file(id.value));
    if (removed.isErr()) return err(removed.error);
    const workspace = bound.value.workspace;
    const unindexed = await this.index((entries) =>
      entries.filter((e) => !(e.session === this.session && e.workspace === workspace)),
    );
    if (unindexed.isErr()) return err(unindexed.error);
    const recorded = await this.d.journal.record(id.value, {
      type: "agent",
      origin: "run",
      agent: bound.value.host,
      text: `closed herdr workspace ${bound.value.workspace}`,
    });
    if (recorded.isErr()) return err(recorded.error);
    return ok({ runId: id.value, closed: true });
  }

  /** The run's binding, or null when it has none. */
  async binding(runId: string): Promise<Result<HerdrBinding | null, MetatorError>> {
    const file = this.file(runId);
    if (!(await this.d.fs.exists(file))) return ok(null);
    const text = await this.d.fs.read(file);
    if (text.isErr()) return err(text.error);
    const raw = parseJsonDocument(text.value, file);
    if (raw.isErr()) return err(raw.error);
    return HerdrBindingDocument.parse(raw.value, file);
  }

  /** The repository and run a herdr workspace of this session belongs to, or null. */
  async locate(workspace: string): Promise<Result<HerdrWorkspace | null, MetatorError>> {
    const entries = await this.entries();
    if (entries.isErr()) return err(entries.error);
    return ok(entries.value.find((e) => e.session === this.session && e.workspace === workspace) ?? null);
  }

  private get session(): string {
    return this.d.session ?? "default";
  }

  private async entries(): Promise<Result<readonly HerdrWorkspace[], MetatorError>> {
    if (!this.d.machine) return ok([]);
    const text = await this.d.machine.read(HERDR_WORKSPACES);
    if (text.isErr()) return err(text.error);
    if (text.value === undefined) return ok([]);
    const raw = parseJsonDocument(text.value, HERDR_WORKSPACES);
    if (raw.isErr()) return err(raw.error);
    return HerdrWorkspacesDocument.parse(raw.value, HERDR_WORKSPACES).map((d) => d.entries);
  }

  private async index(
    change: (entries: readonly HerdrWorkspace[]) => HerdrWorkspace[],
  ): Promise<Result<void, MetatorError>> {
    if (!this.d.machine) return ok(undefined);
    const entries = await this.entries();
    if (entries.isErr()) return err(entries.error);
    return this.d.machine.write(
      HERDR_WORKSPACES,
      serializeJsonDocument(HerdrWorkspacesDocument.stamp({ entries: change(entries.value) })),
    );
  }

  private file(runId: string): string {
    return `${this.d.repo.runDir(runId)}/herdr.json`;
  }
}
