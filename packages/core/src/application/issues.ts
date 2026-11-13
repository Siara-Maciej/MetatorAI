import { MetatorError } from "../domain/errors.ts";
import { InProcessLock } from "../domain/in-process-lock.ts";
import {
  byBacklogOrder,
  type Issue,
  IssueDocument,
  type IssuePriority,
  type IssueRef,
  issueTask,
  nextIssueId,
  proposalDecision,
  proposalQuestion,
} from "../domain/issue.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock, FileLock, FileSystem } from "../ports/index.ts";
import { loadDocument, writeDocument } from "./document-io.ts";
import type { MetatorPaths } from "./paths.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";
import type { InitRun } from "./runs.ts";

export interface IssuesDependencies {
  readonly fs: FileSystem;
  readonly paths: Pick<MetatorPaths, "issues">;
  readonly clock: Clock;
  readonly journal: Pick<RunJournal, "ask" | "questions">;
  readonly repo: Pick<RunRepository, "resolveId" | "load">;
  readonly initRun: Pick<InitRun, "execute">;
  /** `issues.proposeFromAgents`: false refuses proposals. */
  readonly proposalsAllowed?: () => Promise<boolean>;
  /** One writer at a time for an issue's id and its run; the runtime gives the lock across processes. */
  readonly lock?: FileLock;
}

export interface IssuePatch {
  readonly title?: string;
  readonly body?: string;
  readonly priority?: IssuePriority;
  readonly labels?: readonly string[];
  readonly refs?: readonly IssueRef[];
}

/** What starting a run on an issue takes. */
export interface StartIssueInput {
  readonly workflow: string;
  readonly worktree?: boolean;
  readonly autonomy?: "L0" | "L1" | "L2";
  /** Start although tracked files have uncommitted changes: the run does not need them. */
  readonly allowDirty?: boolean;
}

/**
 * The backlog (S4): tasks a person adds, agents propose, and runs start from. A proposal is a
 * question of the run in the inbox; the person's answer there is the decision, applied the next
 * time the backlog is read, so the CLI, the daemon and the app agree without another store.
 */
export class Issues {
  private readonly lock: FileLock;

  constructor(private readonly d: IssuesDependencies) {
    this.lock = d.lock ?? new InProcessLock();
  }

  /** Taking the next id and writing the issue under it is one step: two adders never get one id (R6). */
  private numbered<T>(work: () => Promise<Result<T, MetatorError>>): Promise<Result<T, MetatorError>> {
    const ids = `${this.d.paths.issues}/ids`;
    return this.lock.hold(ids, work);
  }

  private file(id: string): string {
    return `${this.d.paths.issues}/${id}.json`;
  }

  async list(
    input: { readonly status?: Issue["status"]; readonly runId?: string } = {},
  ): Promise<Result<readonly Issue[], MetatorError>> {
    const all = await this.load();
    if (all.isErr()) return err(all.error);
    const synced = await this.applyAnswers(all.value);
    if (synced.isErr()) return err(synced.error);
    return ok(
      synced.value
        .filter((i) => !input.status || i.status === input.status)
        .filter(
          (i) =>
            !input.runId ||
            i.runId === input.runId ||
            i.proposedBy?.runId === input.runId ||
            i.refs.some((r) => r.run === input.runId),
        )
        .sort(byBacklogOrder),
    );
  }

  async show(id: string): Promise<Result<Issue, MetatorError>> {
    const all = await this.list();
    if (all.isErr()) return err(all.error);
    const found = all.value.find((i) => i.id === id);
    return found
      ? ok(found)
      : err(MetatorError.notFound(`issue ${id}`, { hint: "`metator issue list` shows the backlog." }));
  }

  /** A person adds a task: open at once, decided by them. */
  async add(
    input: IssuePatch & {
      readonly title: string;
      readonly by: string;
      /** The outside item an intake rule made it from (T2). */
      readonly source?: NonNullable<Issue["source"]>;
    },
  ): Promise<Result<Issue, MetatorError>> {
    if (input.by.trim() === "") return err(MetatorError.usage("say who adds the task: --by <name>"));
    if (input.title.trim() === "") return err(MetatorError.usage("a task needs a title"));
    return this.numbered(async () => {
      const all = await this.load();
      if (all.isErr()) return err(all.error);
      const now = this.d.clock.now().toISOString();
      const issue: Issue = {
        id: nextIssueId(all.value.map((i) => i.id)),
        title: input.title,
        body: input.body ?? "",
        status: "open",
        priority: input.priority ?? "normal",
        labels: [...(input.labels ?? [])],
        refs: [...(input.refs ?? [])],
        decidedBy: { by: input.by, at: now, decision: "added" },
        ...(input.source ? { source: input.source } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const saved = await this.save(issue);
      return saved.map(() => issue);
    });
  }

  /**
   * An agent proposes a task (never adds one): the proposal is written as `proposed` and becomes a
   * question of its run in the inbox; the person's answer decides it.
   */
  async propose(
    input: IssuePatch & { readonly title: string; readonly agent: string; readonly runId?: string },
  ): Promise<Result<{ readonly issue: Issue; readonly questionId: string }, MetatorError>> {
    if (this.d.proposalsAllowed && !(await this.d.proposalsAllowed()))
      return err(
        MetatorError.usage(
          "agents may not propose tasks here (issues.proposeFromAgents is off)",
          "Say it in your summary instead.",
        ),
      );
    if (input.title.trim() === "") return err(MetatorError.usage("a task needs a title"));
    const runId = await this.d.repo.resolveId(input.runId);
    if (runId.isErr()) return err(runId.error);
    const record = await this.d.repo.load(runId.value);
    if (record.isErr()) return err(record.error);
    return this.numbered(() => this.writeProposal(input, runId.value, record.value.state.stage));
  }

  private async writeProposal(
    input: IssuePatch & { readonly title: string; readonly agent: string },
    runId: string,
    stage: string,
  ): Promise<Result<{ readonly issue: Issue; readonly questionId: string }, MetatorError>> {
    const all = await this.load();
    if (all.isErr()) return err(all.error);
    const now = this.d.clock.now().toISOString();
    const draft: Issue = {
      id: nextIssueId(all.value.map((i) => i.id)),
      title: input.title,
      body: input.body ?? "",
      status: "proposed",
      priority: input.priority ?? "normal",
      labels: [...(input.labels ?? [])],
      refs: [...(input.refs ?? []), ...(input.refs?.some((r) => r.run) ? [] : [{ run: runId }])],
      proposedBy: { agent: input.agent, runId, at: now },
      createdAt: now,
      updatedAt: now,
    };
    const asked = await this.d.journal.ask(runId, proposalQuestion(draft, stage));
    if (asked.isErr()) return err(asked.error);
    const issue: Issue = {
      ...draft,
      proposedBy: { ...(draft.proposedBy as NonNullable<Issue["proposedBy"]>), questionId: asked.value.id },
    };
    const saved = await this.save(issue);
    if (saved.isErr()) return err(saved.error);
    return ok({ issue, questionId: asked.value.id });
  }

  /** A person decides a proposal outside the inbox (`issue decide`): the same two outcomes. */
  async decide(
    id: string,
    input: { readonly by: string; readonly decision: "add" | "drop" } & IssuePatch,
  ): Promise<Result<Issue, MetatorError>> {
    const issue = await this.show(id);
    if (issue.isErr()) return err(issue.error);
    if (issue.value.status !== "proposed")
      return err(MetatorError.usage(`issue ${id} is ${issue.value.status}, not a proposal`));
    if (input.by.trim() === "") return err(MetatorError.usage("say who decides: --by <name>"));
    const now = this.d.clock.now().toISOString();
    const next: Issue = {
      ...issue.value,
      ...patchOf(input),
      status: input.decision === "add" ? "open" : "dropped",
      decidedBy: { by: input.by, at: now, decision: input.decision === "add" ? "added" : "dropped" },
      updatedAt: now,
    };
    const saved = await this.save(next);
    return saved.map(() => next);
  }

  async edit(id: string, patch: IssuePatch): Promise<Result<Issue, MetatorError>> {
    const issue = await this.show(id);
    if (issue.isErr()) return err(issue.error);
    const next: Issue = { ...issue.value, ...patchOf(patch), updatedAt: this.d.clock.now().toISOString() };
    const saved = await this.save(next);
    return saved.map(() => next);
  }

  async close(id: string, input: { readonly by: string }): Promise<Result<Issue, MetatorError>> {
    return this.setStatus(id, "done", input.by);
  }

  async drop(id: string, input: { readonly by: string }): Promise<Result<Issue, MetatorError>> {
    return this.setStatus(id, "dropped", input.by);
  }

  /**
   * A run on the task: its title and body are the task, the issue is in progress and remembers the
   * run. `allowDirty` starts the worktree from the last commit although tracked files changed.
   */
  async start(
    id: string,
    input: StartIssueInput,
  ): Promise<Result<{ readonly issue: Issue; readonly runId: string }, MetatorError>> {
    // Answers given in the inbox are applied first (outside the lock: applying one may start a run).
    const known = await this.show(id);
    if (known.isErr()) return err(known.error);
    // From looking at the issue to writing its run, nobody else starts it: one issue, one run (R6).
    return this.lock.hold(this.file(id), () => this.startLocked(id, input));
  }

  private async startLocked(
    id: string,
    input: StartIssueInput,
  ): Promise<Result<{ readonly issue: Issue; readonly runId: string }, MetatorError>> {
    const issue = await this.read(this.file(id));
    if (issue.isErr()) return err(issue.error);
    if (issue.value.status === "proposed")
      return err(
        MetatorError.usage(
          `issue ${id} is a proposal: a person adds it first (\`metator issue decide ${id} --add --by <name>\`)`,
        ),
      );
    if (issue.value.status === "dropped" || issue.value.status === "done")
      return err(MetatorError.usage(`issue ${id} is ${issue.value.status}`));
    if (issue.value.status === "in-progress" && issue.value.runId) {
      const run = await this.d.repo.load(issue.value.runId);
      if (run.isOk() && run.value.state.status === "active")
        return err(
          MetatorError.usage(
            `issue ${id} is already in progress: its run ${issue.value.runId} is still active`,
            `Go on with it (\`metator run continue --run ${issue.value.runId}\`), or end it first (\`metator run close --aborted --run ${issue.value.runId}\`).`,
          ),
        );
    }
    const started = await this.d.initRun.execute({
      workflow: input.workflow,
      task: issueTask(issue.value),
      ...(input.autonomy ? { autonomy: input.autonomy } : {}),
      ...(input.worktree === false ? {} : { worktree: input.allowDirty ? { allowDirty: true } : {} }),
    });
    if (started.isErr()) return err(started.error);
    const next: Issue = {
      ...issue.value,
      status: "in-progress",
      runId: started.value.runId,
      updatedAt: this.d.clock.now().toISOString(),
    };
    const saved = await this.save(next);
    if (saved.isErr()) return err(saved.error);
    return ok({ issue: next, runId: started.value.runId });
  }

  private async setStatus(
    id: string,
    status: Issue["status"],
    by: string,
  ): Promise<Result<Issue, MetatorError>> {
    const issue = await this.show(id);
    if (issue.isErr()) return err(issue.error);
    if (by.trim() === "") return err(MetatorError.usage("say who decides: --by <name>"));
    const now = this.d.clock.now().toISOString();
    const next: Issue = {
      ...issue.value,
      status,
      ...(status === "dropped" ? { decidedBy: { by, at: now, decision: "dropped" as const } } : {}),
      updatedAt: now,
    };
    const saved = await this.save(next);
    return saved.map(() => next);
  }

  /** Proposals whose inbox question was answered take the answer: open, open and started, or dropped. */
  private async applyAnswers(issues: readonly Issue[]): Promise<Result<Issue[], MetatorError>> {
    const out: Issue[] = [];
    for (const issue of issues) {
      const p = issue.proposedBy;
      if (issue.status !== "proposed" || !p?.runId || !p.questionId) {
        out.push(issue);
        continue;
      }
      const questions = await this.d.journal.questions(p.runId);
      if (questions.isErr()) {
        out.push(issue);
        continue;
      }
      const q = questions.value.find((x) => x.id === p.questionId);
      const decision = proposalDecision(q?.answer);
      if (!decision || !q?.answer) {
        out.push(issue);
        continue;
      }
      const now = q.answer.at;
      let next: Issue = {
        ...issue,
        status: decision === "dropped" ? "dropped" : "open",
        decidedBy: { by: q.answer.by, at: now, decision: decision === "dropped" ? "dropped" : "added" },
        updatedAt: now,
      };
      const saved = await this.save(next);
      if (saved.isErr()) return err(saved.error);
      if (decision === "start") {
        // In a new worktree where one can be made; without one where worktrees are not wired.
        const workflow = await this.workflowOf(p.runId);
        let started = await this.start(next.id, { workflow });
        if (started.isErr()) started = await this.start(next.id, { workflow, worktree: false });
        if (started.isOk()) next = started.value.issue;
      }
      out.push(next);
    }
    return ok(out);
  }

  private async workflowOf(runId: string): Promise<string> {
    const record = await this.d.repo.load(runId);
    return record.isOk() ? record.value.workflow.id : "mt-feature";
  }

  private async load(): Promise<Result<Issue[], MetatorError>> {
    const files = await this.d.fs.glob([`${this.d.paths.issues}/*.json`]);
    const out: Issue[] = [];
    for (const file of [...files].sort()) {
      const parsed = await this.read(file);
      if (parsed.isErr()) return err(parsed.error);
      out.push(parsed.value);
    }
    return ok(out);
  }

  private async read(file: string): Promise<Result<Issue, MetatorError>> {
    return loadDocument(this.d.fs, file, IssueDocument);
  }

  private save(issue: Issue): Promise<Result<void, MetatorError>> {
    return writeDocument(this.d.fs, this.file(issue.id), IssueDocument, issue);
  }
}

const patchOf = (p: IssuePatch): Partial<Issue> => ({
  ...(p.title !== undefined ? { title: p.title } : {}),
  ...(p.body !== undefined ? { body: p.body } : {}),
  ...(p.priority !== undefined ? { priority: p.priority } : {}),
  ...(p.labels !== undefined ? { labels: [...p.labels] } : {}),
  ...(p.refs !== undefined ? { refs: [...p.refs] } : {}),
});
