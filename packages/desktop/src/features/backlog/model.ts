/**
 * Analysis and plan in the Backlog (round 17, stage 2b; pure, tested). What the item detail says of
 * its analysis and plan (one freshness badge each), which of Analyse / Make plan / Implement it
 * offers and why one is disabled, a parent's children with one state word each and what each waits
 * for, a system plan step's detail on a tile click, and where the app goes once a button started an
 * agent (its terminal, the way "+ New chat" opens the thread). The daemon decides freshness and
 * what an item waits for (`GET /issues`); nothing here computes either again.
 */
import type { Freshness, Issue } from "../../shared/api/api.ts";
import { plural } from "../../shared/model/format.ts";
import type { Tone } from "../../shared/model/look.ts";
import type { Route } from "../../shared/model/route.ts";

export type { Freshness };

/** What an analysis or a plan was made from (Issue v3 `Snapshot`). */
export interface SnapshotLike {
  /** The text, under `.metator/issues/<id>/`. */
  readonly file: string;
  readonly at: string;
  readonly commit?: string | undefined;
}

/** An item's plan: the snapshot with the run that made it. */
export type PlanSnapshotLike = SnapshotLike & {
  readonly runId: string;
  readonly kind: "plan" | "system-plan";
};

/**
 * A Backlog item as the app reads it: the document (`Issue`) with what v3 adds, and what
 * `GET /issues` adds to each (its snapshots' freshness, its children, what it waits for).
 */
export type BacklogItem = Pick<Issue, "id" | "title" | "status"> & {
  readonly parent?: string | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly threadId?: string | undefined;
  readonly analysis?: SnapshotLike | undefined;
  readonly plan?: PlanSnapshotLike | undefined;
  /** A child made from a system plan's step: the system run, its plan, the step. */
  readonly step?: { readonly runId: string; readonly plan: string; readonly stepId: string } | undefined;
  readonly freshness?:
    | { readonly analysis?: Freshness | undefined; readonly plan?: Freshness | undefined }
    | undefined;
  /** Its children, by id, in their order. */
  readonly children?: readonly string[] | undefined;
  /** The items it depends on that are not done yet: why Implement waits. */
  readonly waitsFor?: readonly string[] | undefined;
  /** A parent's children done (dropped counts as done) of all, as the daemon counts them. */
  readonly progress?: { readonly done: number; readonly of: number } | undefined;
};

/* ---------- freshness ---------- */

/** How many changed files a badge names before "+N". */
export const BADGE_FILES = 3;

/** The file's name as a person reads it in a badge: its last part. */
const baseName = (path: string): string => path.split("/").pop() || path;

/** `fresh`, `stale: invoice.ts, tax.ts +2`, `old: 15 days`. */
export function freshnessText(f: Freshness): string {
  switch (f.state) {
    case "fresh":
      return "fresh";
    case "stale": {
      const shown = f.changed.slice(0, BADGE_FILES).map(baseName);
      const more = f.changed.length - shown.length;
      return shown.length === 0 ? "stale" : `stale: ${shown.join(", ")}${more > 0 ? ` +${more}` : ""}`;
    }
    case "old":
      return `old: ${plural(f.days, "day")}`;
  }
}

/** Fresh is green; stale (it blocks Make plan) red; old only warns, amber. */
export function freshnessTone(f: Freshness): Tone {
  return f.state === "fresh" ? "green" : f.state === "stale" ? "red" : "amber";
}

const isStale = (f: Freshness | undefined): f is Extract<Freshness, { state: "stale" }> =>
  f?.state === "stale";

/* ---------- the buttons of an item ---------- */

/** A button of the item detail: its words, and why it cannot be pressed when it cannot. */
export interface ItemButton {
  readonly label: string;
  readonly disabled?: string | undefined;
}

export interface ItemButtons {
  readonly analyse?: ItemButton | undefined;
  readonly plan?: ItemButton | undefined;
  readonly implement?: ItemButton | undefined;
}

export const ANALYSE = "Analyse";
export const REANALYSE = "Re-analyse";
export const MAKE_PLAN = "Make plan";
export const IMPLEMENT = "Implement";
export const REVIEW_THEN_IMPLEMENT = "Review plan, then implement";

/** The titles of items by id (an id the list does not have stays an id). */
const titlesOf = (ids: readonly string[], all: readonly Pick<BacklogItem, "id" | "title">[]): string[] =>
  ids.map((id) => all.find((i) => i.id === id)?.title ?? id);

/** `waits for Price model, API endpoint`, or undefined when it waits for nothing. */
export function waitsText(
  item: Pick<BacklogItem, "waitsFor">,
  all: readonly Pick<BacklogItem, "id" | "title">[],
): string | undefined {
  const ids = item.waitsFor ?? [];
  return ids.length > 0 ? `waits for ${titlesOf(ids, all).join(", ")}` : undefined;
}

/**
 * Which of Analyse / Make plan / Implement an item offers. Only an open item has them (a proposal
 * is added first; a run works on one in progress; a finished one is finished).
 * - Analyse is "Re-analyse" once it has an analysis.
 * - Make plan is disabled while the analysis is stale (the daemon refuses it too).
 * - Implement is "Review plan, then implement" when its plan is stale; it is disabled while the
 *   item waits for others (the daemon's `waitsFor`).
 * - A parent with children starts its children one by one: no plan or start of its own.
 */
export function itemButtons(
  item: BacklogItem,
  all: readonly Pick<BacklogItem, "id" | "title">[] = [],
): ItemButtons {
  if (item.status !== "open") return {};
  const analysis = item.freshness?.analysis;
  const plan = item.freshness?.plan;
  const parts = childIds(item, all as readonly BacklogItem[]).length > 0;
  const whole = parts ? "its parts start one by one: implement them" : undefined;
  const waits = waitsText(item, all);
  return {
    analyse: { label: item.analysis ? REANALYSE : ANALYSE },
    plan: {
      label: MAKE_PLAN,
      disabled:
        whole ??
        (isStale(analysis)
          ? `the analysis is stale${analysis.changed.length > 0 ? `: ${analysis.changed.join(", ")}` : ""}; re-analyse first`
          : undefined),
    },
    implement: {
      label: item.plan && isStale(plan) ? REVIEW_THEN_IMPLEMENT : IMPLEMENT,
      disabled: whole ?? waits,
    },
  };
}

/**
 * Why buttons cannot be pressed, one line each; buttons that share a reason say it once, without
 * their names ("its parts start one by one: implement them", not twice).
 */
export function whyDisabled(buttons: readonly (ItemButton | undefined)[]): string[] {
  const off = buttons.filter((b): b is ItemButton & { disabled: string } => b?.disabled !== undefined);
  const reasons = [...new Set(off.map((b) => b.disabled))];
  if (off.length > 1 && reasons.length === 1)
    return [`${reasons[0]?.charAt(0).toUpperCase()}${reasons[0]?.slice(1)}`];
  return off.map((b) => `${b.label}: ${b.disabled}`);
}

/**
 * What an item points at, for its detail: file and note refs as text, and the runs it came from
 * (shown by their task); the item's own run and its plan's run are shown elsewhere, not again.
 */
export function pointsAt(item: Pick<Issue, "refs" | "runId"> & Pick<BacklogItem, "plan">): {
  readonly files: Issue["refs"];
  readonly runs: string[];
} {
  const shown = new Set([item.runId, item.plan?.runId].filter((r): r is string => r !== undefined));
  return {
    files: item.refs.filter((r) => r.run === undefined),
    runs: [...new Set(item.refs.flatMap((r) => (r.run !== undefined && !shown.has(r.run) ? [r.run] : [])))],
  };
}

/* ---------- parents and children ---------- */

/** A parent's children: what the daemon lists, else the items that name it as their parent. */
export function childIds(item: Pick<BacklogItem, "id" | "children">, all: readonly BacklogItem[]): string[] {
  if (item.children) return [...item.children];
  return all.filter((i) => i.parent === item.id).map((i) => i.id);
}

/** Done and dropped are both finished: a dropped child does not hold its parent back. */
export const isFinishedItem = (i: Pick<BacklogItem, "status">): boolean =>
  i.status === "done" || i.status === "dropped";

/** Done and Drop finish a task for good (the daemon has no reopen): asked before, in words. */
export const finishQuestion = (i: Pick<BacklogItem, "id" | "title">, how: "done" | "drop"): string =>
  how === "done"
    ? `Mark ${i.id} "${i.title}" done? The app cannot reopen it.`
    : `Drop ${i.id} "${i.title}"? The app cannot reopen it.`;

/** What keeps the + task form from adding: a title of spaces is no title. */
export const newTaskProblem = (title: string): string | undefined =>
  title.trim() === "" ? "a task needs a title" : undefined;

/**
 * `2 of 3 done` (a dropped child counts as done), or undefined for an item with no children. The
 * daemon's count when it sends one; else counted from the list.
 */
export function childrenProgress(item: BacklogItem, all: readonly BacklogItem[]): string | undefined {
  if (item.progress && item.progress.of > 0) return `${item.progress.done} of ${item.progress.of} done`;
  const ids = childIds(item, all);
  if (ids.length === 0) return undefined;
  const done = ids.filter((id) => {
    const c = all.find((i) => i.id === id);
    return c !== undefined && isFinishedItem(c);
  }).length;
  return `${done} of ${ids.length} done`;
}

/** The one word of an item's row. */
export type ItemWord =
  | "proposed"
  | "open"
  | "analysed"
  | "stale"
  | "plan ready"
  | "plan stale"
  | "waits"
  | "working"
  | "done"
  | "dropped";

/**
 * One word for an item's row: where it stands, most useful first. An open item that waits for
 * another says `waits`; else its plan (`plan ready` / `plan stale`), else its analysis
 * (`analysed` / `stale`), else `open`.
 */
export function itemWord(item: BacklogItem): ItemWord {
  switch (item.status) {
    case "proposed":
      return "proposed";
    case "in-progress":
      return "working";
    case "done":
      return "done";
    case "dropped":
      return "dropped";
  }
  if ((item.waitsFor ?? []).length > 0) return "waits";
  if (item.plan) return isStale(item.freshness?.plan) ? "plan stale" : "plan ready";
  if (item.analysis) return isStale(item.freshness?.analysis) ? "stale" : "analysed";
  return "open";
}

/** The colour of an item's word. */
export function itemTone(word: ItemWord): Tone {
  switch (word) {
    case "proposed":
    case "waits":
    case "plan stale":
    case "stale":
      return "amber";
    case "working":
      return "violet";
    case "plan ready":
    case "done":
      return "green";
    case "analysed":
      return "teal";
    default:
      return "faint";
  }
}

/** A child's row under its parent: its title, its word, and what it waits for. */
export interface ChildRow {
  readonly id: string;
  readonly title: string;
  readonly word: ItemWord;
  readonly waits?: string | undefined;
}

/** A parent's children in their order, each with its word and what it waits for. */
export function childRows(parent: BacklogItem, all: readonly BacklogItem[]): ChildRow[] {
  return childIds(parent, all).flatMap((id) => {
    const c = all.find((i) => i.id === id);
    if (!c) return [];
    const waits = c.status === "open" ? waitsText(c, all) : undefined;
    return [{ id: c.id, title: c.title, word: itemWord(c), ...(waits ? { waits } : {}) }];
  });
}

/** One row of the Backlog's list: an item, and whether it sits under its parent. */
export interface ListRowOf<T extends BacklogItem> {
  readonly item: T;
  readonly child: boolean;
}

/**
 * The Backlog's list in three parts: proposals, open (open and in progress), finished. A child
 * sits right under its parent, in the parent's part, whatever its own state; a child whose parent
 * is not in the list stands on its own.
 */
export function backlogRows<T extends BacklogItem>(
  items: readonly T[],
): { proposals: ListRowOf<T>[]; open: ListRowOf<T>[]; finished: ListRowOf<T>[] } {
  const ids = new Set(items.map((i) => i.id));
  const top = items.filter((i) => !(i.parent && ids.has(i.parent)));
  const withChildren = (list: readonly T[]): ListRowOf<T>[] =>
    list.flatMap((p) => [
      { item: p, child: false },
      ...childIds(p, items as readonly BacklogItem[]).flatMap((id) => {
        const c = items.find((i) => i.id === id && i.parent === p.id);
        return c ? [{ item: c, child: true }] : [];
      }),
    ]);
  return {
    proposals: withChildren(top.filter((i) => i.status === "proposed")),
    open: withChildren(top.filter((i) => i.status === "open" || i.status === "in-progress")),
    finished: withChildren(top.filter(isFinishedItem)),
  };
}

/** A row's second line: a parent's progress, a child's wait, else nothing. */
export function rowSub(item: BacklogItem, all: readonly BacklogItem[]): string | undefined {
  return (
    childrenProgress(item, all) ?? (item.status === "open" ? waitsText(item, all) : undefined) ?? undefined
  );
}

/* ---------- a plan view's "Create Backlog item" ---------- */

/** The parent item made from a plan run (or a system run), when one was made. */
export function itemOfPlan<T extends BacklogItem>(items: readonly T[], runId: string): T | undefined {
  return items.find((i) => i.plan?.runId === runId && !i.parent);
}

export const CREATE_ITEM = "Create Backlog item";
export const OPEN_ITEM = "Open its Backlog item";

/** The plan view's button: make the item, or open the one made. */
export function fromPlanButton(
  items: readonly BacklogItem[],
  runId: string,
): { readonly label: string; readonly itemId?: string | undefined } {
  const made = itemOfPlan(items, runId);
  return made ? { label: OPEN_ITEM, itemId: made.id } : { label: CREATE_ITEM };
}

/** The Backlog part made from a system plan's step: the item whose `step` names that plan and step. */
export function itemOfStep<T extends BacklogItem>(
  items: readonly T[],
  plan: string,
  stepId: string,
): T | undefined {
  return items.find((i) => i.step?.plan === plan && i.step.stepId === stepId);
}

/* ---------- a system plan step's detail ---------- */

/** What a step of a system plan is, as `GET /system/plans/:id` gives it (with round 17's fields). */
export interface StepLike {
  readonly id: string;
  readonly app: string;
  readonly repo?: string | undefined;
  /** Its summary. */
  readonly task: string;
  readonly dependsOn: readonly string[];
  readonly status: "pending" | "running" | "done" | "blocked";
  readonly run?: string | undefined;
  readonly runState?: string | undefined;
  /** The run that planned it ("Plan this step"), reused when it runs. */
  readonly planRunId?: string | undefined;
  /** That run, and its plan's steps once it has a plan. */
  readonly planRun?:
    | {
        readonly runId: string;
        readonly status: string;
        readonly stage?: string | undefined;
        readonly root?: string | undefined;
        readonly steps?:
          | readonly {
              readonly id?: string;
              readonly action?: string;
              readonly path: string;
              readonly intent: string;
            }[]
          | undefined;
      }
    | undefined;
  /** The files of its app the system analysis lists. */
  readonly files?: readonly string[] | undefined;
  readonly contracts?: readonly { readonly id: string; readonly role: string }[] | undefined;
}

export const PLAN_STEP = "Plan this step";
export const FILES_UNKNOWN = "files: not known until planned";

/** The detail a tile opens: what the step already has, and whether "Plan this step" can start. */
export interface StepDetail {
  readonly id: string;
  readonly summary: string;
  readonly app: string;
  /** `change prices-api`, one per contract. */
  readonly contracts: readonly string[];
  /** The steps it waits for, by their summary. */
  readonly after: readonly string[];
  /** Its app's files from the system analysis, or the line that says they are not known. */
  readonly files: readonly string[] | typeof FILES_UNKNOWN;
  /** One word: `pending`, `planning`, `planned`, `running`, `done`, `blocked`. */
  readonly word: "pending" | "planning" | "planned" | "running" | "done" | "blocked";
  readonly planRunId?: string | undefined;
  /** Its own plan, once its plan run wrote one: `1 a failing test · test/price.test.ts`. */
  readonly planLines: readonly string[];
  readonly run?: string | undefined;
  /** "Plan this step": absent once its plan or its run exists. */
  readonly button?: ItemButton | undefined;
}

/** A plan run that ended without a plan: the step can be planned again. */
const ENDED_WITHOUT_PLAN = new Set(["aborted", "escalated"]);

/**
 * A step's detail. "Plan this step" is there while the step has neither a run nor a plan run that
 * is planning or planned (the daemon refuses the same): a step's plan reads only its own
 * repository, so it can be made at any time, before the system plan is approved too (to see what
 * the step will do). Once planned the detail shows its plan and its run; once it runs, its run has
 * the plan. A plan run that was aborted leaves the button back.
 */
export function stepDetail(
  plan: { readonly steps: readonly StepLike[] },
  stepId: string,
): StepDetail | undefined {
  const s = plan.steps.find((x) => x.id === stepId);
  if (!s) return undefined;
  const summaryOf = (id: string) => plan.steps.find((x) => x.id === id)?.task ?? id;
  const files = s.files && s.files.length > 0 ? [...s.files] : FILES_UNKNOWN;
  const planStatus = s.planRun?.status;
  const replan = planStatus !== undefined && ENDED_WITHOUT_PLAN.has(planStatus);
  const planning = s.planRunId !== undefined && !replan;
  const word: StepDetail["word"] =
    s.status !== "pending"
      ? s.status
      : !planning
        ? "pending"
        : planStatus === "planned" || planStatus === "done"
          ? "planned"
          : "planning";
  const button: ItemButton | undefined =
    planning || s.run || s.status !== "pending" ? undefined : { label: PLAN_STEP };
  return {
    id: s.id,
    summary: s.task,
    app: s.app,
    contracts: (s.contracts ?? []).map((c) => `${c.role} ${c.id}`),
    after: s.dependsOn.map(summaryOf),
    files,
    word,
    planLines: planLines(s.planRun),
    ...(s.planRunId ? { planRunId: s.planRunId } : {}),
    ...(s.run ? { run: s.run } : {}),
    ...(button ? { button } : {}),
  };
}

/**
 * The steps of `GET /system/plans/:id` as the detail reads them: the view's step (its repository,
 * its run's state, the files of its app) with what the plan document says of it (its contracts,
 * the run that planned it).
 */
export function stepsOfView(view: {
  readonly plan: {
    readonly steps: readonly {
      readonly id: string;
      readonly contracts?: readonly { readonly id: string; readonly role: string }[] | undefined;
      readonly planRunId?: string | undefined;
    }[];
  };
  readonly steps: readonly StepLike[];
}): StepLike[] {
  return view.steps.map((s) => {
    const doc = view.plan.steps.find((d) => d.id === s.id);
    const planRunId = s.planRunId ?? doc?.planRunId;
    const contracts = s.contracts ?? doc?.contracts;
    return { ...s, ...(planRunId ? { planRunId } : {}), ...(contracts ? { contracts } : {}) };
  });
}

/** A planned step's plan in lines a person reads: `1 a failing test · test/currency.test.ts`. */
export function planLines(
  plan:
    | { readonly steps?: readonly { readonly intent: string; readonly path: string }[] | undefined }
    | null
    | undefined,
): string[] {
  return (plan?.steps ?? []).map((s, i) => `${i + 1} ${s.intent} · ${s.path}`);
}

/* ---------- where a button that starts an agent goes ---------- */

/**
 * The terminal a button's agent works in, shown at once (as "+ New chat" opens its thread): a
 * run's pane on the run's Terminal tab; a pane with no run on the workbench.
 */
export function shownRoute(started: {
  readonly runId?: string | undefined;
  readonly paneId?: string | undefined;
}): Route | undefined {
  if (started.runId)
    return {
      screen: "run",
      runId: started.runId,
      tab: "terminal",
      ...(started.paneId ? { pane: started.paneId } : {}),
    };
  if (started.paneId) return { screen: "grid", pane: started.paneId };
  return undefined;
}
