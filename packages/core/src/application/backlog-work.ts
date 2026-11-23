import { MetatorError } from "../domain/errors.ts";
import { planId } from "../domain/ids.ts";
import type { Issue } from "../domain/issue.ts";
import {
  analysePrompt,
  analysisFactsSection,
  backlogFromPlan,
  citedPaths,
  type Freshness,
  type IssueLinks,
  issueViews,
  planBrief,
  planCites,
  planSummary,
  startCarry,
  systemPlanSummary,
  waitRefusal,
  workflowFor,
} from "../domain/issue-snapshot.ts";
import { type Plan, PlanDocument } from "../domain/plan.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { type SystemPlan, SystemPlanDocument } from "../domain/system-plan.ts";
import type { Thread } from "../domain/thread.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import { readDocument } from "./document-io.ts";
import type { IssueSnapshots } from "./issue-snapshots.ts";
import type { Issues, StartIssueInput } from "./issues.ts";
import type { Panes, PaneView } from "./panes.ts";
import type { SimilarMatch } from "./patterns.ts";
import type { RunRepository } from "./run-repository.ts";
import type { SystemPlanStore } from "./system-plans.ts";
import type { StartSystemStep } from "./system-runs.ts";
import type { Threads } from "./threads.ts";

/** Where an item's own files live: its analysis and its plan, next to its document. */
export const issueDir = (issues: string, id: string): string => `${issues}/${id}`;

/** An item as the Backlog shows it: with its links and whether its analysis and plan still hold. */
export type IssueView = IssueLinks & {
  readonly freshness: { readonly analysis?: Freshness; readonly plan?: Freshness };
};

/** One item with the texts the detail shows. */
export type IssueDetail = IssueView & {
  readonly analysisText?: string;
  readonly planSummary?: string;
  readonly planRun?: { readonly runId: string; readonly status: string; readonly stage: string };
};

/** How "Implement" started the item's run. */
export type StartMode = "plan-from" | "plan-review" | "new";

export interface BacklogWorkDependencies {
  readonly issues: Pick<Issues, "list" | "show" | "create" | "update" | "start">;
  readonly snapshots: Pick<IssueSnapshots, "take" | "freshness">;
  readonly fs: FileSystem;
  /** `.metator/issues`. */
  readonly dir: string;
  readonly runs: Pick<RunRepository, "load" | "runDir" | "hasFile">;
  readonly systemPlans: Pick<SystemPlanStore, "exists" | "load" | "file" | "loadAnalysis">;
  /** One step of a system plan, planned or started on its own. */
  readonly steps?: Pick<StartSystemStep, "execute">;
  readonly threads?: Pick<Threads, "show" | "create" | "addRun" | "addIssue" | "ofRun">;
  /** The deterministic part of an analysis: who imports a file, and how the repository already does it. */
  readonly facts?: {
    dependents(file: string): Promise<Result<readonly string[], MetatorError>>;
    similar(file: string): Promise<Result<readonly SimilarMatch[], MetatorError>>;
  };
  /** The daemon's panes: "Analyse" opens the guide where a person sees it. */
  readonly panes?: Pick<Panes, "openWorkspace" | "openTab" | "openPane">;
  readonly clock: Clock;
}

/**
 * Analysis and plan in the Backlog (ADR-0096): an item's analysis recorded with its snapshot, a
 * plan made on demand (a run that stops `planned`), "Implement" that takes the plan (from build
 * when it still holds, from its review when it does not), items made from a plan (a parent and,
 * for a system plan, a child per step), and the thread the work continues in.
 */
export class BacklogWork {
  constructor(private readonly d: BacklogWorkDependencies) {}

  /** The Backlog with plans that became ready linked, and each item's links and freshness. */
  async list(
    input: { readonly status?: Issue["status"]; readonly runId?: string } = {},
  ): Promise<Result<readonly IssueView[], MetatorError>> {
    const synced = await this.sync();
    if (synced.isErr()) return err(synced.error);
    const all = await this.d.issues.list();
    if (all.isErr()) return err(all.error);
    const shown = await this.d.issues.list(input);
    if (shown.isErr()) return err(shown.error);
    const ids = new Set(shown.value.map((i) => i.id));
    const out: IssueView[] = [];
    for (const v of issueViews(all.value)) if (ids.has(v.id)) out.push(await this.withFreshness(v));
    return ok(shown.value.map((i) => out.find((o) => o.id === i.id) as IssueView));
  }

  async detail(id: string): Promise<Result<IssueDetail, MetatorError>> {
    const listed = await this.list();
    if (listed.isErr()) return err(listed.error);
    const view = listed.value.find((i) => i.id === id);
    if (!view)
      return err(MetatorError.notFound(`issue ${id}`, { hint: "`metator issue list` shows the backlog." }));
    const text = view.analysis ? await this.d.fs.read(view.analysis.file) : undefined;
    const summary = view.plan ? await this.planSummaryOf(view.plan) : undefined;
    const run = view.plan ? await this.d.runs.load(view.plan.runId) : undefined;
    return ok({
      ...view,
      ...(text?.isOk() ? { analysisText: text.value } : {}),
      ...(summary ? { planSummary: summary } : {}),
      ...(view.plan && run?.isOk()
        ? {
            planRun: {
              runId: view.plan.runId,
              status: run.value.state.status,
              stage: run.value.state.stage,
            },
          }
        : {}),
    });
  }

  /**
   * An analysis recorded (`issue analyze`): a new item, open at once because the person asked for
   * it, proposed by the agent that wrote it and linked to its thread; or the item named, whose
   * analysis it replaces. The text is kept with the facts MetatorAI adds, and snapshotted.
   */
  async analyze(input: {
    readonly issue?: string;
    readonly title?: string;
    readonly text: string;
    readonly by: string;
    readonly agent?: string;
    readonly threadId?: string;
  }): Promise<Result<IssueView, MetatorError>> {
    if (input.text.trim() === "")
      return err(
        MetatorError.usage("the analysis is empty: give its text with --text (or --text - on stdin)"),
      );
    if (input.by.trim() === "") return err(MetatorError.usage("say who asked for it: --by <name>"));
    let id = input.issue;
    if (!id) {
      const title = input.title?.trim() ?? "";
      if (title === "")
        return err(
          MetatorError.usage("a new item needs a title: --title <words>, or name one with --issue <id>"),
        );
      const made = await this.d.issues.create(1, (ids, now) =>
        ok([
          {
            id: ids[0] as string,
            title,
            body: "",
            status: "open",
            priority: "normal",
            labels: [],
            refs: [],
            dependsOn: [],
            proposedBy: { agent: input.agent ?? "mt-chat", at: now },
            decidedBy: { by: input.by.trim(), at: now, decision: "added" },
            ...(input.threadId ? { threadId: input.threadId } : {}),
            createdAt: now,
            updatedAt: now,
          },
        ]),
      );
      if (made.isErr()) return err(made.error);
      id = (made.value[0] as Issue).id;
    } else {
      const known = await this.d.issues.show(id);
      if (known.isErr()) return err(known.error);
    }
    const file = `${issueDir(this.d.dir, id)}/analysis.md`;
    const cited = citedPaths(input.text);
    const snapshot = await this.d.snapshots.take(file, cited);
    if (snapshot.isErr()) return err(snapshot.error);
    const facts = analysisFactsSection({
      at: snapshot.value.at,
      commit: snapshot.value.commit,
      cited: snapshot.value.cites.map((c) => c.path),
      missing: cited.filter((c) => !snapshot.value.cites.some((x) => x.path === c)),
      packages: snapshot.value.packages,
      ...(await this.factsOf(snapshot.value.cites.map((c) => c.path))),
    });
    const written = await this.d.fs.write(file, `${input.text.trim()}\n\n${facts}`);
    if (written.isErr()) return err(written.error);
    const saved = await this.d.issues.update(id, (i) =>
      ok({
        ...i,
        analysis: snapshot.value,
        ...(input.threadId && !i.threadId ? { threadId: input.threadId } : {}),
      }),
    );
    if (saved.isErr()) return err(saved.error);
    if (saved.value.threadId && this.d.threads) {
      const linked = await this.d.threads.addIssue(saved.value.threadId, saved.value.id, saved.value.title);
      if (linked.isErr()) return err(linked.error);
    }
    return this.viewOf(saved.value.id);
  }

  /** "Analyse" / "Re-analyse": the guide in a pane a person sees, told to analyse the item and record it. */
  async openAnalysis(
    id: string,
    input: { readonly host?: string } = {},
  ): Promise<Result<{ readonly issue: IssueView; readonly pane: PaneView }, MetatorError>> {
    if (!this.d.panes)
      return err(
        MetatorError.usage("analysing in a pane needs the daemon (`metator serve`)", "Start the app."),
      );
    const view = await this.viewOf(id);
    if (view.isErr()) return err(view.error);
    const workspace = await this.d.panes.openWorkspace({ label: "backlog" });
    if (workspace.isErr()) return err(workspace.error);
    const tab = await this.d.panes.openTab(workspace.value.id, id);
    if (tab.isErr()) return err(tab.error);
    const pane = await this.d.panes.openPane({
      workspace: workspace.value.id,
      tab: tab.value,
      role: "apps",
      label: `analyse ${id}`,
      process: {
        kind: "host",
        ...(input.host ? { host: input.host } : {}),
        agent: "mt-guide",
        prompt: analysePrompt(view.value),
      },
    });
    if (pane.isErr()) return err(pane.error);
    return ok({ issue: view.value, pane: pane.value });
  }

  /**
   * "Make plan": a run of the item's workflow that stops once its plan is approved. Refused while
   * the analysis is stale; a step's item plans its step instead.
   */
  async plan(
    id: string,
    input: { readonly workflow?: string; readonly session?: { readonly host?: string } } = {},
  ): Promise<Result<PlanStarted, MetatorError>> {
    const view = await this.viewOf(id);
    if (view.isErr()) return err(view.error);
    const item = view.value;
    const analysis = item.freshness.analysis;
    if (analysis?.state === "stale")
      return err(
        MetatorError.usage(
          `the analysis is stale: ${analysis.changed.join(", ")}; re-analyse first`,
          `Re-analyse it (the Analyse button, or the guide's \`metator issue analyze --issue ${id}\`), then make the plan.`,
        ),
      );
    if (item.step) {
      if (!this.d.steps) return err(MetatorError.usage("this item plans a system plan step: no system here"));
      const planned = await this.d.steps.execute({
        id: item.step.plan,
        step: item.step.stepId,
        plan: true,
        parent: item.step.runId,
        ...(input.session?.host ? { host: input.session.host } : {}),
      });
      if (planned.isErr()) return err(planned.error);
      const linked = await this.inOpenThread(item, planned.value.run);
      if (linked.isErr()) return err(linked.error);
      return this.planStarted(id, planned.value.run, planned.value);
    }
    const text = item.analysis ? await this.d.fs.read(item.analysis.file) : undefined;
    // A plan changes no code: it is made in this checkout, as it is, without a worktree of its own.
    const started = await this.d.issues.start(id, {
      workflow: input.workflow ?? workflowFor(item),
      worktree: false,
      allowDirty: true,
      until: "plan",
      brief: planBrief(item, text?.isOk() ? text.value : undefined),
      ...(input.session ? { session: input.session } : {}),
    });
    if (started.isErr()) return err(started.error);
    // The plan is the item's next step in its thread (the chat that analysed it): the run is listed there.
    const linked = await this.inOpenThread(item, started.value.runId);
    if (linked.isErr()) return err(linked.error);
    return this.planStarted(id, started.value.runId, started.value);
  }

  private async planStarted(
    id: string,
    runId: string,
    opened: {
      readonly session?: { readonly paneId: string; readonly host: string };
      readonly noSession?: string;
    },
  ): Promise<Result<PlanStarted, MetatorError>> {
    const view = await this.viewOf(id);
    if (view.isErr()) return err(view.error);
    return ok({
      issue: view.value,
      runId,
      ...(opened.session ? { session: { paneId: opened.session.paneId, host: opened.session.host } } : {}),
      ...(opened.noSession ? { noSession: opened.noSession } : {}),
    });
  }

  /**
   * "Implement": a fresh plan → a run from it, at build; a stale plan → from its review (plan lint,
   * the critic and the person's approval, then build); no plan → the whole workflow. A child waits
   * for its dependencies; a step's item starts its step. The run continues in the item's open
   * thread, else in a new one that carries the old thread's summary and the item's files.
   */
  async implement(
    id: string,
    input: Omit<StartIssueInput, "workflow" | "planFrom" | "until" | "brief"> & {
      readonly workflow?: string;
      readonly by: string;
      /** Open the new thread's chat pane (a daemon serves the repository). */
      readonly chat?: boolean;
    },
  ): Promise<Result<Implemented, MetatorError>> {
    const view = await this.viewOf(id);
    if (view.isErr()) return err(view.error);
    const item = view.value;
    if (item.children.length > 0)
      return err(
        MetatorError.usage(
          `issue ${id} is the parent of ${item.children.join(", ")}: start its children`,
          "Each child starts on its own once what it waits for is done.",
        ),
      );
    const all = await this.d.issues.list();
    if (all.isErr()) return err(all.error);
    const waits = waitRefusal(item, all.value);
    if (waits) return err(waits);
    let runId: string;
    let mode: StartMode = "new";
    let opened: { session?: { paneId: string; host: string }; noSession?: string } = {};
    if (item.step) {
      if (!this.d.steps) return err(MetatorError.usage("this item is a system plan step: no system here"));
      const started = await this.d.steps.execute({
        id: item.step.plan,
        step: item.step.stepId,
        parent: item.step.runId,
        ...(input.session?.host ? { host: input.session.host } : {}),
      });
      if (started.isErr()) return err(started.error);
      runId = started.value.run;
      opened = {
        ...(started.value.session ? { session: started.value.session } : {}),
        ...(started.value.noSession ? { noSession: started.value.noSession } : {}),
      };
      const saved = await this.d.issues.update(id, (i) => ok({ ...i, status: "in-progress", runId }));
      if (saved.isErr()) return err(saved.error);
    } else {
      const plan = item.plan?.kind === "plan" ? item.plan : undefined;
      const stale = item.freshness.plan?.state === "stale";
      mode = plan ? (stale ? "plan-review" : "plan-from") : "new";
      const { by: _by, chat: _chat, workflow, ...rest } = input;
      const started = await this.d.issues.start(id, {
        ...rest,
        workflow: workflow ?? workflowFor(item),
        ...(plan ? { planFrom: { run: plan.runId, from: stale ? "review" : "build" } } : {}),
      });
      if (started.isErr()) return err(started.error);
      runId = started.value.runId;
      opened = {
        ...(started.value.session ? { session: started.value.session } : {}),
        ...(started.value.noSession ? { noSession: started.value.noSession } : {}),
      };
    }
    const thread = await this.continueIn(item, runId, input);
    if (thread.isErr()) return err(thread.error);
    const after = await this.viewOf(id);
    if (after.isErr()) return err(after.error);
    return ok({
      issue: after.value,
      runId,
      mode,
      ...opened,
      ...(thread.value ? { thread: thread.value } : {}),
    });
  }

  /** The item's thread, when it has one and it is open, lists the run (with a fact); else nothing changes. */
  private async inOpenThread(
    item: Pick<Issue, "threadId" | "title">,
    runId: string,
  ): Promise<Result<Thread | undefined, MetatorError>> {
    const threads = this.d.threads;
    if (!threads || !item.threadId) return ok(undefined);
    const thread = (await threads.show(item.threadId)).unwrapOr(undefined as never);
    if (thread?.state !== "open") return ok(undefined);
    return threads.addRun(thread.id, runId, item.title);
  }

  /** The thread the item's run belongs to: its own while open, else a new one that says where it comes from. */
  private async continueIn(
    item: Issue,
    runId: string,
    input: { readonly by: string; readonly chat?: boolean; readonly session?: { readonly host?: string } },
  ): Promise<Result<{ readonly id: string; readonly paneId?: string } | undefined, MetatorError>> {
    const threads = this.d.threads;
    if (!threads) return ok(undefined);
    const open = await this.inOpenThread(item, runId);
    if (open.isErr()) return err(open.error);
    if (open.value) return ok({ id: open.value.id });
    const old: Thread | undefined = item.threadId
      ? (await threads.show(item.threadId)).unwrapOr(undefined as never)
      : undefined;
    const made = await threads.create({
      title: item.title.slice(0, 80),
      by: input.by,
      from: { issue: item.id, ...(old ? { thread: old.id } : {}) },
      carry: startCarry(item, old?.summary),
      pane: input.chat === true,
      ...(input.session?.host ? { host: input.session.host } : {}),
    });
    if (made.isErr()) return err(made.error);
    const added = await threads.addRun(made.value.thread.id, runId, item.title);
    if (added.isErr()) return err(added.error);
    const linked = await this.d.issues.update(item.id, (i) => ok({ ...i, threadId: made.value.thread.id }));
    if (linked.isErr()) return err(linked.error);
    return ok({ id: made.value.thread.id, ...(made.value.pane ? { paneId: made.value.pane.id } : {}) });
  }

  /**
   * "Create a Backlog item from this plan": one parent (the task, the plan's summary, the plan's
   * snapshot, the thread of the run's chat) and, for a system plan, one child per step.
   */
  async fromPlan(input: {
    readonly runId: string;
    readonly by: string;
  }): Promise<Result<{ readonly parent: IssueView; readonly children: readonly IssueView[] }, MetatorError>> {
    if (input.by.trim() === "") return err(MetatorError.usage("say who adds it: --by <name>"));
    const run = await this.d.runs.load(input.runId);
    if (run.isErr()) return err(run.error);
    const all = await this.d.issues.list();
    if (all.isErr()) return err(all.error);
    const existing = all.value.find((i) => i.plan?.runId === input.runId && !i.parent);
    if (existing)
      return err(
        MetatorError.usage(
          `the plan of run ${input.runId} is already in the Backlog as ${existing.id}`,
          `Open it: \`metator issue show ${existing.id}\`.`,
        ),
      );
    const source = await this.planOf(input.runId, run.value.task);
    if (source.isErr()) return err(source.error);
    const thread = this.d.threads ? await this.d.threads.ofRun(input.runId) : undefined;
    const by = input.by.trim();
    const plan = source.value;
    const body = plan.kind === "plan" ? planSummary(plan.plan) : systemPlanSummary(plan.plan);
    const made = await this.d.issues.create(
      1 + (plan.kind === "system-plan" ? plan.plan.steps.length : 0),
      async (ids, now) => {
        const items = backlogFromPlan({
          ids,
          runId: input.runId,
          title: run.value.task.split("\n")[0] ?? run.value.task,
          body,
          ...(plan.kind === "system-plan" ? { system: plan.plan } : {}),
        });
        const file = `${issueDir(this.d.dir, items.parent.id)}/${plan.kind === "plan" ? "plan.json" : "system-plan.yml"}`;
        const copied = await this.d.fs.write(file, plan.text);
        if (copied.isErr()) return err(copied.error);
        const snapshot = await this.d.snapshots.take(file, plan.cites);
        if (snapshot.isErr()) return err(snapshot.error);
        const base = (now: string) => ({
          status: "open" as const,
          priority: "normal" as const,
          labels: [],
          refs: [{ run: input.runId }],
          decidedBy: { by, at: now, decision: "added" as const },
          ...(thread ? { threadId: thread.id } : {}),
          createdAt: now,
          updatedAt: now,
        });
        return ok([
          {
            ...base(now),
            id: items.parent.id,
            title: items.parent.title,
            body: items.parent.body,
            dependsOn: [],
            plan: { ...snapshot.value, runId: input.runId, kind: plan.kind },
          },
          ...items.children.map((c) => ({
            ...base(now),
            id: c.id,
            title: c.title,
            body: c.body,
            dependsOn: [...(c.dependsOn ?? [])],
            ...(c.parent ? { parent: c.parent } : {}),
            ...(c.step ? { step: c.step } : {}),
          })),
        ]);
      },
    );
    if (made.isErr()) return err(made.error);
    const [parent, ...children] = made.value as [Issue, ...Issue[]];
    if (thread && this.d.threads) {
      const linked = await this.d.threads.addIssue(thread.id, parent.id, parent.title);
      if (linked.isErr()) return err(linked.error);
    }
    const views = await this.list();
    if (views.isErr()) return err(views.error);
    const find = (i: Issue) => views.value.find((v) => v.id === i.id) as IssueView;
    return ok({ parent: find(parent), children: children.map(find) });
  }

  /** A run's plan: its `plan.json`, else the system plan of its task. */
  private async planOf(
    runId: string,
    task: string,
  ): Promise<
    Result<
      | {
          readonly kind: "plan";
          readonly plan: Plan;
          readonly text: string;
          readonly cites: readonly string[];
        }
      | {
          readonly kind: "system-plan";
          readonly plan: SystemPlan;
          readonly text: string;
          readonly cites: readonly string[];
        },
      MetatorError
    >
  > {
    const file = `${this.d.runs.runDir(runId)}/plan.json`;
    if (await this.d.runs.hasFile(runId, "plan.json")) {
      const text = await this.d.fs.read(file);
      if (text.isErr()) return err(text.error);
      const plan = await readDocument(this.d.fs, file, PlanDocument, "json");
      if (plan.isErr()) return err(plan.error);
      if (!plan.value) return err(MetatorError.notFound(file));
      return ok({ kind: "plan", plan: plan.value, text: text.value, cites: planCites(plan.value) });
    }
    const id = planId(task);
    if (!(await this.d.systemPlans.exists(id)))
      return err(
        MetatorError.usage(
          `run ${runId} has no plan yet: no plan.json and no system plan ${id}`,
          "Make its plan first; the item is made from a plan.",
        ),
      );
    const plan = await this.d.systemPlans.load(id);
    if (plan.isErr()) return err(plan.error);
    const text = await this.d.fs.read(this.d.systemPlans.file(id));
    if (text.isErr()) return err(text.error);
    const analysis = await this.d.systemPlans.loadAnalysis(id);
    const cites = analysis.isOk() ? (analysis.value?.applications ?? []).flatMap((a) => a.files) : [];
    return ok({ kind: "system-plan", plan: plan.value, text: text.value, cites });
  }

  /**
   * What happened since the Backlog was last read: an item whose plan run stopped `planned` gets
   * the plan (copied, snapshotted) and is open again; a step's item is done once its step is.
   */
  private async sync(): Promise<Result<void, MetatorError>> {
    const all = await this.d.issues.list();
    if (all.isErr()) return err(all.error);
    const plans = new Map<string, SystemPlan | undefined>();
    for (const item of all.value) {
      if (item.step && item.status !== "done" && item.status !== "dropped") {
        if (!plans.has(item.step.plan))
          plans.set(
            item.step.plan,
            (await this.d.systemPlans.exists(item.step.plan))
              ? (await this.d.systemPlans.load(item.step.plan)).unwrapOr(undefined as never)
              : undefined,
          );
        const step = plans.get(item.step.plan)?.steps.find((s) => s.id === item.step?.stepId);
        if (step?.status === "done") {
          const done = await this.d.issues.update(item.id, (i) => ok({ ...i, status: "done" }));
          if (done.isErr()) return err(done.error);
        }
        continue;
      }
      const linked = await this.linkPlan(item);
      if (linked.isErr()) return err(linked.error);
    }
    return ok(undefined);
  }

  /** A run stopped `planned` (`AdvanceRun`): the item it plans takes the plan now, as the code is. */
  async planned(runId: string): Promise<Result<void, MetatorError>> {
    const all = await this.d.issues.list();
    if (all.isErr()) return err(all.error);
    const item = all.value.find((i) => i.runId === runId);
    return item ? this.linkPlan(item) : ok(undefined);
  }

  /** The item's plan run stopped planned: its plan is copied and snapshotted, and the item is open again. */
  private async linkPlan(item: Issue): Promise<Result<void, MetatorError>> {
    if (item.status !== "in-progress" || !item.runId || item.plan?.runId === item.runId) return ok(undefined);
    const run = await this.d.runs.load(item.runId);
    if (run.isErr() || run.value.state.status !== "planned") return ok(undefined);
    const runId = item.runId;
    const source = `${this.d.runs.runDir(runId)}/plan.json`;
    const plan = await readDocument(this.d.fs, source, PlanDocument, "json");
    const text = await this.d.fs.read(source);
    if (plan.isErr() || !plan.value || text.isErr()) return ok(undefined);
    const file = `${issueDir(this.d.dir, item.id)}/plan.json`;
    const copied = await this.d.fs.write(file, text.value);
    if (copied.isErr()) return err(copied.error);
    const snapshot = await this.d.snapshots.take(file, planCites(plan.value));
    if (snapshot.isErr()) return err(snapshot.error);
    const linked = await this.d.issues.update(item.id, (i) =>
      ok({ ...i, status: "open", plan: { ...snapshot.value, runId, kind: "plan" } }),
    );
    return linked.map(() => undefined);
  }

  private async viewOf(id: string): Promise<Result<IssueView, MetatorError>> {
    const listed = await this.list();
    if (listed.isErr()) return err(listed.error);
    const found = listed.value.find((i) => i.id === id);
    return found
      ? ok(found)
      : err(MetatorError.notFound(`issue ${id}`, { hint: "`metator issue list` shows the backlog." }));
  }

  private async withFreshness(view: IssueLinks): Promise<IssueView> {
    const analysis = view.analysis ? await this.d.snapshots.freshness(view.analysis) : undefined;
    const plan = view.plan ? await this.d.snapshots.freshness(view.plan) : undefined;
    return {
      ...view,
      freshness: {
        ...(analysis?.isOk() ? { analysis: analysis.value } : {}),
        ...(plan?.isOk() ? { plan: plan.value } : {}),
      },
    };
  }

  /** The summary of the plan as it was copied to the item (not as its run may have it now). */
  private async planSummaryOf(plan: NonNullable<Issue["plan"]>): Promise<string | undefined> {
    if (plan.kind === "plan") {
      const parsed = await readDocument(this.d.fs, plan.file, PlanDocument, "json");
      return parsed.isOk() && parsed.value ? planSummary(parsed.value) : undefined;
    }
    const system = await readDocument(this.d.fs, plan.file, SystemPlanDocument, "yaml");
    return system.isOk() && system.value ? systemPlanSummary(system.value) : undefined;
  }

  /** Transitive dependents and an exemplar per cited file, when the repository can say. */
  private async factsOf(files: readonly string[]): Promise<{
    dependents: { path: string; count: number }[];
    exemplars: { path: string; pattern: string; at: string }[];
  }> {
    const dependents: { path: string; count: number }[] = [];
    const exemplars: { path: string; pattern: string; at: string }[] = [];
    if (!this.d.facts) return { dependents, exemplars };
    for (const path of files) {
      const deps = await this.d.facts.dependents(path);
      if (deps.isOk()) dependents.push({ path, count: deps.value.length });
      const similar = await this.d.facts.similar(path);
      const best = similar.isOk() ? similar.value.find((m) => m.file !== path) : undefined;
      if (best) exemplars.push({ path, pattern: best.pattern, at: `${best.file}:${best.line}` });
    }
    return { dependents, exemplars };
  }
}

export interface PlanStarted {
  readonly issue: IssueView;
  readonly runId: string;
  readonly session?: { readonly paneId: string; readonly host: string };
  readonly noSession?: string;
}

export interface Implemented extends PlanStarted {
  readonly mode: StartMode;
  readonly thread?: { readonly id: string; readonly paneId?: string };
}
