/**
 * Work as parent tasks (pure, tested): the sidebar's rows and the Board's top level. A task is a
 * system task (a system plan with its system run and its steps across repositories), a run with
 * child runs, a standalone run, or a backlog task or proposal not started yet. Its subtasks are
 * the board cards of its steps and child runs (pending steps too); its phase is its head's.
 */
import type { SystemPlanView, WorkPhase } from "./api.ts";
import type { BoardCard, CardState } from "./board.ts";
import { type RunShown, rollUp } from "./model.ts";

export interface WorkTask {
  readonly key: string;
  readonly kind: "system" | "parent" | "run" | "issue" | "proposal";
  readonly title: string;
  readonly column: WorkPhase;
  /** One state word for the whole task. */
  readonly state: CardState;
  /** Its steps done, of all (a task made of steps). */
  readonly progress?: { readonly done: number; readonly of: number } | undefined;
  /** How many of its cards need a person, and how many escalated. */
  readonly needsYou: number;
  readonly escalated: number;
  /** The repositories it works in, in the order its cards name them. */
  readonly repos: readonly string[];
  readonly host?: string | undefined;
  readonly ageMs: number;
  readonly updatedAt: string;
  /** The card of the task itself (its system run, the parent run, the run, the issue). */
  readonly head?: BoardCard | undefined;
  /** Its steps and child runs, pending steps included. */
  readonly subtasks: readonly BoardCard[];
}

type TaskPlan = Pick<SystemPlanView, "plan" | "steps" | "status">;

const RUN_WORDS: readonly string[] = ["needs you", "working", "escalated", "done", "aborted", "idle"];

/** The state word of a group of cards: the strongest of its runs' states, else its head's. */
function stateOf(cards: readonly BoardCard[], head: BoardCard | undefined): CardState {
  const runStates = cards.filter((c) => RUN_WORDS.includes(c.state)).map((c) => c.state as RunShown);
  if (runStates.length > 0) {
    const strongest = rollUp(runStates);
    // Everything finished but a head that still works (a system run at delivery): the head says.
    return head && RUN_WORDS.includes(head.state) && strongest === "done" ? head.state : strongest;
  }
  return head?.state ?? cards[0]?.state ?? "todo";
}

/** The parent tasks of the board's cards, in no particular order. */
export function workTasks(cards: readonly BoardCard[], plans: readonly TaskPlan[]): WorkTask[] {
  const groups = new Map<string, BoardCard[]>();
  for (const c of cards) {
    const key = c.parent?.key ?? c.key;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const tasks: WorkTask[] = [];
  for (const [key, group] of groups) {
    const plan = key.startsWith("plan:") ? plans.find((p) => `plan:${p.plan.id}` === key) : undefined;
    const parentRun = key.startsWith("run:") && !key.includes("/") ? key.slice("run:".length) : undefined;
    const head = plan
      ? group.find((c) => c.head !== undefined)
      : parentRun
        ? group.find((c) => c.runId === parentRun)
        : group.length === 1
          ? group[0]
          : undefined;
    const subtasks = group.filter((c) => c !== head);
    const single = !plan && !parentRun;
    const column: WorkPhase =
      head?.column ??
      (plan
        ? plan.status === "draft"
          ? "planning"
          : plan.status === "done"
            ? "done"
            : "in-progress"
        : "in-progress");
    const progress = plan
      ? {
          // A step is done when its plan says so, or when its run is (the plan is read back a moment later).
          done: plan.steps.filter(
            (s) =>
              s.status === "done" ||
              (s.run !== undefined && group.some((c) => c.runId === s.run && c.column === "done")),
          ).length,
          of: plan.steps.length,
        }
      : parentRun
        ? { done: subtasks.filter((c) => c.column === "done").length, of: subtasks.length }
        : undefined;
    const repos = [...new Set(group.flatMap((c) => (c.repo ? [c.repo] : [])))];
    const latest = [...group].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    tasks.push({
      key,
      kind: plan
        ? "system"
        : parentRun
          ? "parent"
          : head?.kind === "proposal"
            ? "proposal"
            : head?.kind === "issue"
              ? "issue"
              : "run",
      title: head && !plan ? head.title : (plan?.plan.task ?? group[0]?.parent?.label ?? head?.title ?? key),
      column,
      state: single && head ? head.state : stateOf(group, head),
      ...(progress ? { progress } : {}),
      needsYou: group.filter((c) => c.needsYou).length,
      escalated: group.filter((c) => c.escalated).length,
      repos,
      host: head?.host,
      ageMs: head?.ageMs ?? Math.max(0, ...group.map((c) => c.ageMs)),
      updatedAt: latest?.updatedAt ?? "",
      head,
      subtasks,
    });
  }
  return tasks;
}

/** Tasks as the sidebar lists them: what needs the person first, then the newest change. */
export const byAttentionFirst = (tasks: readonly WorkTask[]): WorkTask[] =>
  [...tasks].sort(
    (a, b) =>
      Number(b.needsYou + b.escalated > 0) - Number(a.needsYou + a.escalated > 0) ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.key.localeCompare(b.key),
  );

/** A task's subtasks grouped by the repository they work in, in the order the repositories first appear. */
export function subtasksByRepo(task: Pick<WorkTask, "subtasks">): { repo: string; cards: BoardCard[] }[] {
  const out: { repo: string; cards: BoardCard[] }[] = [];
  for (const c of task.subtasks) {
    const repo = c.repo ?? "";
    const at = out.find((g) => g.repo === repo);
    if (at) at.cards.push(c);
    else out.push({ repo, cards: [c] });
  }
  for (const g of out)
    g.cards.sort((a, b) => (a.step?.at ?? 0) - (b.step?.at ?? 0) || a.title.localeCompare(b.title));
  return out;
}

/** The task's line under its name: progress, who it needs, where it works. */
export function taskLine(t: WorkTask): string {
  return [
    t.progress ? `${t.progress.done}/${t.progress.of}` : t.head?.stage,
    t.needsYou > 0 ? `${t.needsYou} need${t.needsYou === 1 ? "s" : ""} you` : undefined,
    t.escalated > 0 ? `${t.escalated} escalated` : undefined,
    t.repos.length > 1 ? `${t.repos.length} repositories` : t.repos[0],
    t.host,
  ]
    .filter((x) => x !== undefined && x !== "")
    .join(" · ");
}

/** The tasks a filter keeps at the Board's top level: by any repository it works in, its state, host and words. */
export function filterTasks(
  tasks: readonly WorkTask[],
  f: {
    readonly repos: readonly string[];
    readonly states: readonly string[];
    readonly host?: string | undefined;
    readonly text: string;
  },
): WorkTask[] {
  const text = f.text.trim().toLowerCase();
  return tasks.filter((t) => {
    if (f.repos.length > 0 && !t.repos.some((r) => f.repos.includes(r))) return false;
    if (f.states.length > 0) {
      const has = (s: string) =>
        s === "needs you" ? t.needsYou > 0 : s === "escalated" ? t.escalated > 0 : t.state === s;
      if (!f.states.some(has)) return false;
    }
    if (f.host && t.host !== f.host && !t.subtasks.some((c) => c.host === f.host)) return false;
    if (
      text &&
      ![t.title, ...t.repos, ...t.subtasks.map((c) => c.title)].join(" ").toLowerCase().includes(text)
    )
      return false;
    return true;
  });
}
