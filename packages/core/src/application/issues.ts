import { MetatorError } from "../domain/errors.ts";
import { InProcessLock } from "../domain/in-process-lock.ts";
import {
  byBacklogOrder,
  type Issue,
  IssueDocument,
  type IssuePriority,
  type IssueRef,
  issueBrief,
  nextIssueId,
  PROPOSAL_ADD,
  PROPOSAL_DROP,
  proposalDecision,
  proposalQuestion,
} from "../domain/issue.ts";
import { settledParents, waitRefusal } from "../domain/issue-snapshot.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock, FileLock, FileSystem } from "../ports/index.ts";
import { loadDocument, writeDocument } from "./document-io.ts";
import type { MetatorPaths } from "./paths.ts";
import type { RunJournal } from "./run-journal.ts";
import type { StartRun } from "./run-operations.ts";
import type { RunRepository } from "./run-repository.ts";
import type { InitRun } from "./runs.ts";

/** A run's task in full (intake writes it; a run started from an issue starts with it). */
export const TASK_BRIEF = "task.md";

export interface IssuesDependencies {
  readonly fs: FileSystem;
  readonly paths: Pick<MetatorPaths, "issues">;
  readonly clock: Clock;
  readonly journal: Pick<RunJournal, "ask" | "questions" | "answer">;
  readonly repo: Pick<RunRepository, "resolveId" | "load" | "runDir">;
  readonly initRun: Pick<InitRun, "execute">;
  /** A run started as every front starts one, with its conductor where a person sees it (`session`). */
  readonly startRun?: Pick<StartRun, "execute" | "see">;
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
  /** The run only plans: it stops `planned` once its plan is approved (ADR-0096). */
  readonly until?: "plan";
  /** The run takes the approved plan of this run, starting at `build` or at the plan's review. */
  readonly planFrom?: { readonly run: string; readonly from: "build" | "review" };
  /** The run's task.md (default: the item's title and body). */
  readonly brief?: string;
  /** Open the run's conductor where a person sees it (else it is only made, as `run new` makes one). */
  readonly session?: { readonly host?: string };
}

/** An item whose file cannot be read (torn or hand-edited): left out of the backlog, and said. */
export interface UnreadableIssue {
  readonly id: string;
  readonly file: string;
  readonly message: string;
}

/** What a person is told about an unreadable item: the file, and the two ways out. */
export const unreadableIssueWarning = (u: UnreadableIssue): string =>
  `issue ${u.id} cannot be read and is left out (${u.message}): restore ${u.file} (from git or a backup), or delete it to drop the item`;

/** What starting a run on an item gives back. */
export interface StartedIssue {
  readonly issue: Issue;
  readonly runId: string;
  readonly session?: { readonly paneId: string; readonly host: string };
  readonly noSession?: string;
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

  /** The backlog that can be read; an item whose file cannot be read is left out (see `unreadable`). */
  async list(
    input: { readonly status?: Issue["status"]; readonly runId?: string } = {},
  ): Promise<Result<readonly Issue[], MetatorError>> {
    const all = await this.load();
    const answered = await this.applyAnswers(all.issues);
    if (answered.isErr()) return err(answered.error);
    const synced = await this.settleParents(answered.value);
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

  /** Items whose file cannot be read: one broken file never hides the rest of the backlog. */
  async unreadable(): Promise<readonly UnreadableIssue[]> {
    return (await this.load()).unreadable;
  }

  async show(id: string): Promise<Result<Issue, MetatorError>> {
    const all = await this.list();
    if (all.isErr()) return err(all.error);
    const found = all.value.find((i) => i.id === id);
    if (found) return ok(found);
    // An item left out because its file cannot be read says why, not that it is missing.
    if (await this.d.fs.exists(this.file(id))) {
      const broken = await this.read(this.file(id));
      if (broken.isErr()) return err(broken.error);
    }
    return err(MetatorError.notFound(`issue ${id}`, { hint: "`metator issue list` shows the backlog." }));
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
      const taken = await this.takenIds();
      const now = this.d.clock.now().toISOString();
      const issue: Issue = {
        id: nextIssueId(taken),
        title: input.title,
        body: input.body ?? "",
        status: "open",
        priority: input.priority ?? "normal",
        labels: [...(input.labels ?? [])],
        refs: [...(input.refs ?? [])],
        dependsOn: [],
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
    const taken = await this.takenIds();
    const now = this.d.clock.now().toISOString();
    const draft: Issue = {
      id: nextIssueId(taken),
      title: input.title,
      body: input.body ?? "",
      status: "proposed",
      priority: input.priority ?? "normal",
      labels: [...(input.labels ?? [])],
      refs: [...(input.refs ?? []), ...(input.refs?.some((r) => r.run) ? [] : [{ run: runId }])],
      proposedBy: { agent: input.agent, runId, at: now },
      dependsOn: [],
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
    // Looked at again under the lock: a proposal decided meanwhile is not decided a second time.
    const decided = await this.rewrite(id, (current) =>
      current.status !== "proposed"
        ? err(MetatorError.usage(`issue ${id} is ${current.status}, not a proposal`))
        : ok({
            ...current,
            ...patchOf(input),
            status: input.decision === "add" ? "open" : "dropped",
            decidedBy: { by: input.by, at: now, decision: input.decision === "add" ? "added" : "dropped" },
            updatedAt: now,
          }),
    );
    if (decided.isErr()) return err(decided.error);
    const { before, after } = decided.value;
    await this.settleProposal(before, input.decision === "add" ? PROPOSAL_ADD : PROPOSAL_DROP, input.by);
    return ok(after);
  }

  /**
   * A proposal decided outside the inbox (Backlog, `issue decide`, `issue rm`): its question gets
   * the same answer, so it leaves Needs you. A run that ended asks nothing any more: nothing to settle.
   */
  private async settleProposal(issue: Issue, choice: string, by: string): Promise<void> {
    const p = issue.proposedBy;
    if (issue.status !== "proposed" || !p?.runId || !p.questionId) return;
    const questions = await this.d.journal.questions(p.runId);
    const q = questions.isOk() ? questions.value.find((x) => x.id === p.questionId) : undefined;
    if (!q || q.answer) return;
    await this.d.journal.answer(p.runId, q.id, { choices: [choice], by });
  }

  async edit(id: string, patch: IssuePatch): Promise<Result<Issue, MetatorError>> {
    // Answers given in the inbox are applied first; the edit itself changes the item as it is now.
    const issue = await this.show(id);
    if (issue.isErr()) return err(issue.error);
    return this.update(id, (current) => ok({ ...current, ...patchOf(patch) }));
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
  async start(id: string, input: StartIssueInput): Promise<Result<StartedIssue, MetatorError>> {
    // Answers given in the inbox are applied first (outside the lock: applying one may start a run).
    const known = await this.show(id);
    if (known.isErr()) return err(known.error);
    // From looking at the issue to writing its run, nobody else starts it: one issue, one run (R6).
    return this.lock.hold(this.file(id), () => this.startLocked(id, input));
  }

  private async startLocked(id: string, input: StartIssueInput): Promise<Result<StartedIssue, MetatorError>> {
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
    // One rule decides what may start (the system plan's steps use it too): every item it depends on is done.
    const waits = waitRefusal(issue.value, (await this.load()).issues);
    if (waits) return err(waits);
    const run = {
      workflow: input.workflow,
      // The task is the issue's title; its body is the run's task.md, which every agent reads.
      task: issue.value.title,
      ...(input.autonomy ? { autonomy: input.autonomy } : {}),
      ...(input.worktree === false
        ? input.allowDirty
          ? { allowDirty: true }
          : {}
        : { worktree: input.allowDirty ? { allowDirty: true } : {} }),
      ...(input.until ? { until: input.until } : {}),
      ...(input.planFrom ? { planFrom: input.planFrom } : {}),
    };
    // Seen by a person: started as every front starts a run (its worktree set up), else only made.
    const visible = input.session ? this.d.startRun : undefined;
    const started = visible
      ? (await visible.execute(run)).map((s) => s.run)
      : await this.d.initRun.execute(run);
    if (started.isErr()) return err(started.error);
    const runId = started.value.runId;
    // Linked as soon as the run exists: an item left open without it would start a second run.
    const next: Issue = {
      ...issue.value,
      status: "in-progress",
      runId,
      updatedAt: this.d.clock.now().toISOString(),
    };
    const saved = await this.save(next);
    if (saved.isErr()) return err(saved.error);
    // The brief is there before its conductor opens: the first thing every agent reads.
    const brief = await this.d.fs.write(
      `${this.d.repo.runDir(runId)}/${TASK_BRIEF}`,
      input.brief ?? issueBrief(issue.value),
    );
    if (brief.isErr()) return err(brief.error);
    let opened: Pick<StartedIssue, "session" | "noSession"> = {};
    if (visible && input.session) {
      const seen = await visible.see(runId, { session: input.session });
      if (seen.isErr()) return err(seen.error);
      opened = {
        ...(seen.value.session
          ? { session: { paneId: seen.value.session.paneId, host: seen.value.session.host } }
          : {}),
        ...(seen.value.noSession ? { noSession: seen.value.noSession } : {}),
      };
    }
    return ok({ issue: next, runId, ...opened });
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
    const changed = await this.rewrite(id, (current) =>
      ok({
        ...current,
        status,
        ...(status === "dropped" ? { decidedBy: { by, at: now, decision: "dropped" as const } } : {}),
        updatedAt: now,
      }),
    );
    if (changed.isErr()) return err(changed.error);
    if (status === "dropped") await this.settleProposal(changed.value.before, PROPOSAL_DROP, by);
    return ok(changed.value.after);
  }

  /**
   * A parent whose children are all done or dropped is done by itself (ADR-0096), applied when the
   * Backlog is read like a proposal's answer, so every front sees the same.
   */
  private async settleParents(issues: readonly Issue[]): Promise<Result<Issue[], MetatorError>> {
    const ids = new Set(settledParents(issues));
    if (ids.size === 0) return ok([...issues]);
    const now = this.d.clock.now().toISOString();
    const out: Issue[] = [];
    for (const issue of issues) {
      if (!ids.has(issue.id)) {
        out.push(issue);
        continue;
      }
      // Under its lock, and only if nobody changed its status since the backlog was read.
      const done = await this.rewrite(issue.id, (current) =>
        ok(
          current.status === issue.status ? { ...current, status: "done" as const, updatedAt: now } : current,
        ),
      );
      if (done.isErr()) return err(done.error);
      out.push(done.value.after);
    }
    return ok(out);
  }

  /** New items whose ids are taken and written in one step (a parent and its children from a plan). */
  async create(
    count: number,
    make: (
      ids: readonly string[],
      now: string,
    ) => Result<readonly Issue[], MetatorError> | Promise<Result<readonly Issue[], MetatorError>>,
  ): Promise<Result<readonly Issue[], MetatorError>> {
    return this.numbered(async () => {
      const taken = await this.takenIds();
      const ids: string[] = [];
      for (let i = 0; i < count; i++) ids.push(nextIssueId([...taken, ...ids]));
      const made = await make(ids, this.d.clock.now().toISOString());
      if (made.isErr()) return err(made.error);
      for (const issue of made.value) {
        const saved = await this.save(issue);
        if (saved.isErr()) return err(saved.error);
      }
      return ok(made.value);
    });
  }

  /** Reads, changes and writes one item as one step. */
  async update(
    id: string,
    change: (issue: Issue) => Result<Issue, MetatorError>,
  ): Promise<Result<Issue, MetatorError>> {
    const changed = await this.rewrite(id, (current) =>
      change(current).map((next) =>
        next === current ? current : { ...next, updatedAt: this.d.clock.now().toISOString() },
      ),
    );
    return changed.map((c) => c.after);
  }

  /**
   * Every change of an item goes through here: read, change and write under the item's lock, so a
   * start, an edit and a decision at once never write over each other. `change` sees the item as it
   * is now; what it returns is written as it is (the same object: nothing is written).
   */
  private rewrite(
    id: string,
    change: (issue: Issue) => Result<Issue, MetatorError>,
  ): Promise<Result<{ readonly before: Issue; readonly after: Issue }, MetatorError>> {
    return this.lock.hold(this.file(id), async () => {
      const current = await this.read(this.file(id));
      if (current.isErr()) return err(current.error);
      const next = change(current.value);
      if (next.isErr()) return err(next.error);
      if (next.value === current.value) return ok({ before: current.value, after: current.value });
      const saved = await this.save(next.value);
      return saved.map(() => ({ before: current.value, after: next.value }));
    });
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
      const answer = q.answer;
      // Under its lock: a proposal decided meanwhile (`issue decide`, another reader) stays decided.
      let applied = false;
      const decided = await this.rewrite(issue.id, (current) => {
        if (current.status !== "proposed") return ok(current);
        applied = true;
        return ok({
          ...current,
          status: decision === "dropped" ? "dropped" : "open",
          decidedBy: { by: answer.by, at: answer.at, decision: decision === "dropped" ? "dropped" : "added" },
          updatedAt: answer.at,
        });
      });
      if (decided.isErr()) return err(decided.error);
      let next = decided.value.after;
      if (applied && decision === "start") {
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

  /** Every item that can be read; one broken file never hides the others (as runs, R2). */
  private async load(): Promise<{ issues: Issue[]; unreadable: UnreadableIssue[] }> {
    const files = await this.d.fs.glob([`${this.d.paths.issues}/*.json`]);
    const issues: Issue[] = [];
    const unreadable: UnreadableIssue[] = [];
    for (const file of [...files].sort()) {
      const parsed = await this.read(file);
      if (parsed.isOk()) issues.push(parsed.value);
      else unreadable.push({ id: idOf(file), file, message: parsed.error.message });
    }
    return { issues, unreadable };
  }

  /** Ids in use, an unreadable item's too: a new item never writes over a file a person may restore. */
  private async takenIds(): Promise<string[]> {
    const all = await this.load();
    return [...all.issues.map((i) => i.id), ...all.unreadable.map((u) => u.id)];
  }

  private async read(file: string): Promise<Result<Issue, MetatorError>> {
    return loadDocument(this.d.fs, file, IssueDocument);
  }

  private save(issue: Issue): Promise<Result<void, MetatorError>> {
    return writeDocument(this.d.fs, this.file(issue.id), IssueDocument, issue);
  }
}

const idOf = (file: string): string => (file.split("/").at(-1) ?? file).replace(/\.json$/, "");

const patchOf = (p: IssuePatch): Partial<Issue> => ({
  ...(p.title !== undefined ? { title: p.title } : {}),
  ...(p.body !== undefined ? { body: p.body } : {}),
  ...(p.priority !== undefined ? { priority: p.priority } : {}),
  ...(p.labels !== undefined ? { labels: [...p.labels] } : {}),
  ...(p.refs !== undefined ? { refs: [...p.refs] } : {}),
});
