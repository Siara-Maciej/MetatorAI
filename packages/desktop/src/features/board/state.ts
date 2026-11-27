/**
 * What the Board keeps while it is open (ADR-0113): its filter (kept in the window's storage),
 * the fold of finished work, whether a card was dragged (the engine moves cards, not the person),
 * the pending step whose detail is open, and what the last action answered. The board's cards and
 * tasks are worked out here once per change of the daemon's runs, plans and tasks
 * (`feed`), with every unchanged task kept the same object, so a part reads its own piece by
 * selector and draws again only when that piece changed.
 */
import type { Issue } from "../../shared/api/api.ts";
import { shared } from "../../shared/api/query.ts";
import { type Daemon, readAgainNow } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import {
  type BoardCard,
  type BoardFilter,
  boardCards,
  cardState,
  DAY_MS,
  filterCards,
} from "../../shared/model/board.ts";
import { blockedReason } from "../../shared/model/look.ts";
import { sameRepo } from "../../shared/model/places.ts";
import { type Run, workflowChoice } from "../../shared/model/runs.ts";
import type { RepoSystemPlan } from "../../shared/model/system-plans.ts";
import { filterTasks, type WorkTask, workTasks } from "../../shared/model/tasks.ts";
import { navigate } from "../../shared/navigation.ts";
import { type ActionState, IDLE, runAction } from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";
import { saveFilter } from "./filter.ts";

/** The state words the filter offers. */
export const STATES = ["needs you", "working", "blocked"] as const;

/** What the board is made of: the daemon's runs and plans, and every repository's tasks. */
interface BoardSources {
  readonly runs: readonly Run[];
  readonly plans: readonly RepoSystemPlan[];
  /** The repositories the daemon serves (the chips name them even before they have a card). */
  readonly repos: readonly string[];
  readonly issues: readonly { readonly repo: string | undefined; readonly issues: readonly Issue[] }[];
  /** The polled request of the tasks, read again after an action. */
  readonly issuesKey: string;
  /** Why the tasks could not be read, while none were. */
  readonly issuesError: string | undefined;
}

/** A pending step whose detail is open. */
interface OpenStep {
  readonly planId: string;
  readonly stepId: string;
  readonly repo?: string | undefined;
}

export interface BoardState extends ActionState {
  /** The task whose board is shown; none for the top level. */
  readonly openKey: string | undefined;
  readonly filter: BoardFilter;
  /** Done shows its finished work (folded at first, on each board). */
  readonly showDone: boolean;
  /** Done shows the older finished work too. */
  readonly allDone: boolean;
  /** A card was dragged a moment ago: the columns say the engine moves them. */
  readonly dragged: boolean;
  readonly stepOpen: OpenStep | undefined;
  readonly runs: readonly Run[];
  readonly repos: readonly string[];
  readonly cards: readonly BoardCard[];
  readonly tasks: readonly WorkTask[];
  readonly issuesKey: string;
  readonly issuesError: string | undefined;

  /** The daemon's runs, plans or tasks changed: the cards and tasks are worked out again. */
  feed(sources: BoardSources): void;
  /** The route named another task's board (or the top level): it starts with Done folded. */
  routeTo(openKey: string | undefined): void;
  setFilter(filter: BoardFilter): void;
  toggleRepo(repo: string): void;
  toggleState(state: (typeof STATES)[number]): void;
  setHost(host: string | undefined): void;
  setText(text: string): void;
  showFinished(): void;
  showAllDone(): void;
  /** A card was dragged: for a few seconds the columns say a drop changes nothing. */
  drag(): void;
  closeStep(): void;
  closeNotice(): void;
  /** A task made of steps opens its board; a run of its own opens its page; a backlog task the Backlog. */
  openTask(task: WorkTask): void;
  /** A run opens its page; a step not started its detail (round 17); a task in the Backlog. */
  openCard(card: BoardCard): void;
  /** Starts a run on a backlog task, on the repository's first workflow. */
  start(card: BoardCard): Promise<boolean>;
}

export interface BoardInit {
  readonly daemon: Store<Daemon>;
  readonly openKey: string | undefined;
  /** The filter the window kept. */
  readonly filter: BoardFilter;
  /** Opens a run's page. */
  readonly openRun: (runId: string) => void;
}

const MINUTE_MS = 60_000;
/** How long a drag's note stays. */
const DRAG_NOTE_MS = 4000;

const toggle = <T>(list: readonly T[], v: T): T[] =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

export const Board = scopedStore<BoardState, BoardInit>(
  "Board",
  ({ daemon, openKey, filter, openRun }) =>
    (set, get, api) => {
      const setFilter = (f: BoardFilter) => {
        set({ filter: f });
        saveFilter(f);
      };
      const openCard = (c: BoardCard) => {
        if (c.runId) openRun(c.runId);
        else if (c.kind === "step" && c.planId && c.stepId)
          set({ stepOpen: { planId: c.planId, stepId: c.stepId, repo: c.planRepo } });
        else if (c.kind === "step")
          navigate(
            c.systemRunId
              ? { screen: "run", runId: c.systemRunId, tab: "overview" }
              : { screen: "overview", tab: "system" },
          );
        else navigate({ screen: "backlog", ...(c.issueId ? { id: c.issueId } : {}) });
      };
      return {
        ...IDLE,
        openKey,
        filter,
        showDone: false,
        allDone: false,
        dragged: false,
        stepOpen: undefined,
        runs: [],
        repos: [],
        cards: [],
        tasks: [],
        issuesKey: "",
        issuesError: undefined,

        feed: ({ runs, plans, repos, issues, issuesKey, issuesError }) =>
          set((s) => {
            // Ages to the minute: a task that did not change stays the same object for its tile.
            const now = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
            const cards = boardCards({ runs, issues, plans, now });
            return {
              runs,
              repos: shared(s.repos, [...repos]),
              cards: shared(s.cards, cards),
              tasks: shared(s.tasks, workTasks(cards, plans)),
              issuesKey,
              issuesError,
            };
          }),
        routeTo: (key) => {
          if (key !== get().openKey) set({ openKey: key, showDone: false });
        },
        setFilter,
        toggleRepo: (repo) => setFilter({ ...get().filter, repos: toggle(get().filter.repos, repo) }),
        toggleState: (state) => setFilter({ ...get().filter, states: toggle(get().filter.states, state) }),
        setHost: (host) => setFilter({ ...get().filter, host }),
        setText: (text) => setFilter({ ...get().filter, text }),
        showFinished: () => set({ showDone: true }),
        showAllDone: () => set({ allDone: true }),
        drag: () => {
          if (get().dragged) return;
          set({ dragged: true });
          setTimeout(() => set({ dragged: false }), DRAG_NOTE_MS);
        },
        closeStep: () => set({ stepOpen: undefined }),
        closeNotice: () => set({ notice: undefined }),
        openTask: (t) => {
          if (t.kind === "system" || t.kind === "parent") navigate({ screen: "board", task: t.key });
          else if (t.head) openCard(t.head);
        },
        openCard,
        start: (c) =>
          runAction(
            api,
            daemon,
            async () => {
              const { client } = daemon.getState();
              const known = await client.workflows(c.repo);
              const workflow = workflowChoice(
                (known.data?.workflows ?? []).map((w) => w.id),
                undefined,
              );
              if (!workflow)
                return { ok: false, error: { code: "USAGE", message: "this repository has no workflow" } };
              const r = await client.startIssue(c.issueId as string, { workflow }, c.repo);
              if (r.ok && r.data) openRun(r.data.runId);
              return r;
            },
            {
              refused: "the run did not start",
              reload: () => readAgainNow(daemon.getState().url, get().issuesKey),
            },
          ),
      };
    },
);

/** One value of the Board's state: the part draws again only when it changed. */
export const useBoard = <T>(select: (s: BoardState) => T): T => useScoped(Board, select);
/** The store at the moment of an event: no subscription. */
export const useBoardApi = () => useScopedApi(Board);

/* ---------- what the parts select ---------- */

/** The task whose board is open, when it is on the board. */
export const openedOf = (s: Pick<BoardState, "openKey" | "tasks">): WorkTask | undefined =>
  s.openKey ? s.tasks.find((t) => t.key === s.openKey) : undefined;

/** One tile of a column: a task (top level) or a subtask (a task's board). */
export interface Tile {
  readonly key: string;
  readonly column: BoardCard["column"];
  readonly updatedAt: string;
  readonly needsYou: boolean;
  readonly escalated: boolean;
  readonly task?: WorkTask;
  readonly card?: BoardCard;
}

/** The last answer of a function of a few values, while they are the same values. */
function lastOf<A extends readonly unknown[], R>(f: (...args: A) => R): (...args: A) => R {
  let last: { args: A; value: R } | undefined;
  return (...args) => {
    if (last && last.args.length === args.length && last.args.every((a, i) => Object.is(a, args[i])))
      return last.value;
    last = { args, value: f(...args) };
    return last.value;
  };
}

const tilesFrom = lastOf(
  (tasks: readonly WorkTask[], opened: WorkTask | undefined, filter: BoardFilter): readonly Tile[] =>
    opened
      ? filterCards(opened.subtasks, filter).map((c) => ({
          key: c.key,
          column: c.column,
          updatedAt: c.updatedAt,
          needsYou: c.needsYou,
          escalated: c.escalated,
          card: c,
        }))
      : filterTasks(tasks, filter).map((t) => ({
          key: t.key,
          column: t.column,
          updatedAt: t.updatedAt,
          needsYou: t.needsYou > 0,
          escalated: t.escalated > 0,
          task: t,
        })),
);

/** The tiles the filter lets through, on the open board (the same list while nothing it reads changed). */
export const tilesOf = (s: Pick<BoardState, "openKey" | "tasks" | "filter">): readonly Tile[] =>
  tilesFrom(s.tasks, openedOf(s), s.filter);

/** How many tiles the board has before the filter. */
export const totalOf = (s: Pick<BoardState, "openKey" | "tasks">): number => {
  const opened = openedOf(s);
  return opened ? opened.subtasks.length : s.tasks.length;
};

/** A column's tiles in order: what needs you first, then escalated, then the latest; Done keeps the last day. */
export function columnOf(
  s: Pick<BoardState, "openKey" | "tasks" | "filter" | "allDone">,
  column: BoardCard["column"],
  now: number,
): { readonly shown: readonly Tile[]; readonly older: number } {
  const mine = tilesOf(s).filter((t) => t.column === column);
  const rank = (t: Tile) => (t.needsYou ? 0 : t.escalated ? 1 : 2);
  const sorted = [...mine].sort(
    (a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key),
  );
  if (column !== "done" || s.allDone) return { shown: sorted, older: 0 };
  const recent = sorted.filter((t) => now - Date.parse(t.updatedAt) <= DAY_MS);
  return { shown: recent, older: sorted.length - recent.length };
}

/** On a task's board a blocked run says why, in one line (a pending step says what it waits for). */
export function whyOf(runs: readonly Run[], c: BoardCard): string | undefined {
  if (!c.runId || cardState(c) !== "blocked") return undefined;
  return blockedReason({ run: runs.find((r) => r.runId === c.runId && sameRepo(r.repo, c.repo)) });
}

/** Whether the filter holds anything. */
export const filterChanged = (f: BoardFilter): boolean =>
  f.repos.length > 0 || f.states.length > 0 || Boolean(f.host) || f.text !== "";
