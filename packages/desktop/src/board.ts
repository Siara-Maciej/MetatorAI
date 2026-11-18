/**
 * The board (pure, tested): every piece of work in the column of its phase. A run's column is
 * the `phase` the daemon computed from its workflow and stage; a task with no run yet (an open
 * backlog task, an agent's proposal, a system plan step not started) is To do. A card says what
 * it is part of (its parent task and its step); filters and swimlanes read only the cards.
 */
import type { Issue, RunOverview, SystemPlanView, WorkPhase } from "./api.ts";
import { planOrder, type RunShown, runStateOf, stepPlace, systemPlanOf } from "./model.ts";
import { repoLabel } from "./plan-flow.ts";

export const BOARD_COLUMNS: readonly { readonly id: WorkPhase; readonly label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "planning", label: "Planning" },
  { id: "in-progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

/** What a card reads as: a run's state word, or what a task without a run is. */
export type CardState = RunShown | "todo" | "proposed" | "pending";

export interface BoardCard {
  readonly key: string;
  readonly kind: "run" | "issue" | "proposal" | "step";
  readonly column: WorkPhase;
  readonly title: string;
  readonly repo?: string | undefined;
  readonly state: CardState;
  readonly stage?: string | undefined;
  readonly host?: string | undefined;
  /** How long it has existed. */
  readonly ageMs: number;
  /** When it last changed (Done keeps the last day). */
  readonly updatedAt: string;
  /** The task it is a step of: a system plan (`plan:<id>`) or a parent run (`run:<id>`). */
  readonly parent?: { readonly key: string; readonly label: string } | undefined;
  /** Its place among the parent's steps. */
  readonly step?: { readonly at: number; readonly of: number } | undefined;
  /** The head of a task made of steps (a system run): how far its steps are. */
  readonly head?: { readonly done: number; readonly of: number } | undefined;
  /** A step not started: the steps it waits for. */
  readonly waitsFor?: readonly string[] | undefined;
  readonly needsYou: boolean;
  readonly escalated: boolean;
  readonly runId?: string | undefined;
  readonly issueId?: string | undefined;
  /** A pending step: the plan it belongs to, and the repository the plan is read from. */
  readonly planId?: string | undefined;
  readonly planRepo?: string | undefined;
  /** A pending step: the system run whose plan it is, when it is known. */
  readonly systemRunId?: string | undefined;
}

type BoardRun = RunOverview & { readonly repo?: string | undefined };
type BoardPlan = Pick<SystemPlanView, "plan" | "steps" | "waves" | "status"> & {
  readonly repo?: string | undefined;
};

const ageOf = (now: number, at: string) => Math.max(0, now - Date.parse(at));

/** The system run of a plan: the run whose children are its steps' runs, else the one with its task. */
export function systemRunOf<R extends Pick<RunOverview, "runId" | "task" | "children" | "workflow">>(
  plan: Pick<SystemPlanView, "plan" | "steps">,
  runs: readonly R[],
): R | undefined {
  const childRuns = new Set(plan.steps.flatMap((s) => (s.run ? [s.run] : [])));
  return (
    runs.find((r) => r.children?.some((c) => childRuns.has(c))) ??
    runs.find((r) => r.task === plan.plan.task && /system/.test(r.workflow))
  );
}

/** Every card of the board, in no particular order (the columns sort them). */
export function boardCards(input: {
  readonly runs: readonly BoardRun[];
  readonly issues: readonly { readonly repo?: string | undefined; readonly issues: readonly Issue[] }[];
  readonly plans: readonly BoardPlan[];
  readonly now: number;
}): BoardCard[] {
  const { runs, plans, now } = input;
  const cards: BoardCard[] = [];
  const planOfStepRun = (runId: string) => plans.find((p) => p.steps.some((s) => s.run === runId));
  const parentOf = (r: BoardRun): BoardCard["parent"] => {
    const asStep = planOfStepRun(r.runId);
    if (asStep) return { key: `plan:${asStep.plan.id}`, label: asStep.plan.task };
    // A system run is the head of its own task: "only this task" keeps it with its steps.
    const own = systemPlanOf(plans, r, runs);
    if (own) return { key: `plan:${own.plan.id}`, label: own.plan.task };
    const p = r.parent ? runs.find((x) => x.runId === r.parent) : undefined;
    if (p) return { key: `run:${p.runId}`, label: p.task };
    if (r.children && r.children.length > 0) return { key: `run:${r.runId}`, label: r.task };
    return undefined;
  };
  for (const r of runs) {
    const state = runStateOf(r);
    const place = stepPlace(plans, r.runId);
    const asStep = planOfStepRun(r.runId);
    const stepOfRun = asStep?.steps.find((s) => s.run === r.runId);
    const own = asStep ? undefined : systemPlanOf(plans, r, runs);
    cards.push({
      key: `run:${r.repo ?? ""}/${r.runId}`,
      kind: "run",
      column: r.phase ?? (r.status === "done" || r.status === "aborted" ? "done" : "in-progress"),
      // A step's run reads as its step (`api-model: …`), not the long task the engine composed.
      title: stepOfRun ? `${stepOfRun.id}: ${stepOfRun.task}` : r.task,
      repo: r.repo,
      state,
      stage: r.stage,
      host: r.host,
      ageMs: r.elapsedMs,
      updatedAt: r.updatedAt,
      parent: parentOf(r),
      ...(place ? { step: place } : {}),
      ...(own
        ? { head: { done: own.steps.filter((s) => s.status === "done").length, of: own.steps.length } }
        : {}),
      needsYou: state === "needs you",
      escalated: state === "escalated",
      runId: r.runId,
    });
  }
  for (const { repo, issues } of input.issues)
    for (const i of issues) {
      if (i.status !== "open" && i.status !== "proposed") continue;
      cards.push({
        key: `issue:${repo ?? ""}/${i.id}`,
        kind: i.status === "proposed" ? "proposal" : "issue",
        column: "todo",
        title: i.title,
        repo,
        state: i.status === "proposed" ? "proposed" : "todo",
        ageMs: ageOf(now, i.createdAt),
        updatedAt: i.updatedAt,
        // A proposal waits for a person's Add: it needs them.
        needsYou: i.status === "proposed",
        escalated: false,
        issueId: i.id,
      });
    }
  for (const p of plans) {
    const order = planOrder(p);
    const done = new Set(p.steps.filter((s) => s.status === "done").map((s) => s.id));
    const head = systemRunOf(p, runs);
    for (const s of p.steps) {
      if (s.run || s.status !== "pending") continue;
      cards.push({
        key: `step:${p.repo ?? ""}/${p.plan.id}/${s.id}`,
        kind: "step",
        column: "todo",
        title: `${s.id}: ${s.task}`,
        repo: repoLabel(s.repo || s.app),
        state: "pending",
        ageMs: head ? head.elapsedMs : 0,
        updatedAt: head?.updatedAt ?? new Date(now).toISOString(),
        parent: { key: `plan:${p.plan.id}`, label: p.plan.task },
        step: { at: order.indexOf(s.id) + 1, of: order.length },
        waitsFor: s.dependsOn.filter((d) => !done.has(d)),
        needsYou: false,
        escalated: false,
        planId: p.plan.id,
        planRepo: p.repo,
        ...(head ? { systemRunId: head.runId } : {}),
      });
    }
  }
  return cards;
}

/** What the board shows, chosen above it; kept per viewer in the window's storage. */
export interface BoardFilter {
  readonly repos: readonly string[];
  /** One task made of many: its steps and child runs across repositories. */
  readonly parent?: string | undefined;
  readonly states: readonly ("needs you" | "escalated" | "working")[];
  readonly host?: string | undefined;
  readonly text: string;
  /** One swimlane per parent task, and one for standalone work. */
  readonly grouped: boolean;
}

export const NO_FILTER: BoardFilter = { repos: [], states: [], text: "", grouped: false };

/** A stored filter read back: anything that does not fit is the default. */
export function filterFromStorage(raw: string | null | undefined): BoardFilter {
  if (!raw) return NO_FILTER;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof BoardFilter, unknown>>;
    const strings = (x: unknown) =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
    const states = strings(v.states).filter(
      (s): s is BoardFilter["states"][number] => s === "needs you" || s === "escalated" || s === "working",
    );
    return {
      repos: strings(v.repos),
      ...(typeof v.parent === "string" && v.parent ? { parent: v.parent } : {}),
      states,
      ...(typeof v.host === "string" && v.host ? { host: v.host } : {}),
      text: typeof v.text === "string" ? v.text : "",
      grouped: v.grouped === true,
    };
  } catch {
    return NO_FILTER;
  }
}

/** The cards the filter keeps. */
export function filterCards(cards: readonly BoardCard[], f: BoardFilter): BoardCard[] {
  const text = f.text.trim().toLowerCase();
  return cards.filter((c) => {
    if (f.repos.length > 0 && !(c.repo && f.repos.includes(c.repo))) return false;
    if (f.parent && c.parent?.key !== f.parent) return false;
    if (f.states.length > 0 && !f.states.includes(c.state as BoardFilter["states"][number])) return false;
    if (f.host && c.host !== f.host) return false;
    if (text) {
      const words = [c.title, c.repo, c.stage, c.parent?.label, c.host]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!words.includes(text)) return false;
    }
    return true;
  });
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The cards of one column, in the order a person reads them: what needs them first (needs you,
 * escalated), then the newest change. Done keeps the last day unless `all`.
 */
export function columnCards(
  cards: readonly BoardCard[],
  column: WorkPhase,
  now: number,
  all = false,
): { readonly shown: BoardCard[]; readonly older: number } {
  const mine = cards.filter((c) => c.column === column);
  const rank = (c: BoardCard) => (c.needsYou ? 0 : c.escalated ? 1 : 2);
  const sorted = [...mine].sort(
    (a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key),
  );
  if (column !== "done" || all) return { shown: sorted, older: 0 };
  const recent = sorted.filter((c) => now - Date.parse(c.updatedAt) <= DAY_MS);
  return { shown: recent, older: sorted.length - recent.length };
}

/** What a column's header counts: its cards, and how many need a person or escalated. */
export function columnCounts(cards: readonly BoardCard[]): {
  total: number;
  needsYou: number;
  escalated: number;
} {
  return {
    total: cards.length,
    needsYou: cards.filter((c) => c.needsYou).length,
    escalated: cards.filter((c) => c.escalated).length,
  };
}

/** The parent tasks the filter offers: every task some card is a step of, by its label. */
export function parentOptions(
  cards: readonly BoardCard[],
): { readonly key: string; readonly label: string }[] {
  const seen = new Map<string, string>();
  for (const c of cards) if (c.parent && !seen.has(c.parent.key)) seen.set(c.parent.key, c.parent.label);
  return [...seen.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Swimlanes: one per parent task (in the order of their labels), then standalone work. */
export function swimlanes(
  cards: readonly BoardCard[],
): { readonly key: string; readonly label: string; readonly cards: BoardCard[] }[] {
  const lanes = parentOptions(cards).map((p) => ({
    key: p.key,
    label: p.label,
    cards: cards.filter((c) => c.parent?.key === p.key),
  }));
  const alone = cards.filter((c) => !c.parent);
  return alone.length > 0 ? [...lanes, { key: "standalone", label: "Standalone work", cards: alone }] : lanes;
}

/** The line under a card's title: where it is, what it is part of. */
export function cardLine(c: BoardCard): string {
  return [
    c.repo,
    c.kind === "run"
      ? c.column === "done"
        ? undefined
        : c.stage
      : c.kind === "proposal"
        ? "proposal"
        : c.kind === "step"
          ? "not started"
          : "task",
    c.host,
  ]
    .filter((x) => x !== undefined && x !== "")
    .join(" · ");
}

/** The card's part-of line: `step 2 of 4 · Add a currency to prices`. */
export function partOfLine(c: BoardCard): string | undefined {
  if (c.head) return `the whole task · ${c.head.done} of ${c.head.of} steps done`;
  if (!c.parent && !c.step) return undefined;
  return [
    c.step ? `step ${c.step.at} of ${c.step.of}` : undefined,
    c.parent ? `of ${c.parent.label}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
