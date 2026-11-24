/**
 * The Board in two levels. The top level shows only parent tasks (a system task, a run with child
 * runs, a standalone run, a backlog task), each once, in the column of its own phase, with its
 * progress and how many of its steps need the person. A task opens its own board: the same
 * columns with its steps and child runs across repositories, pending steps in To do with what they
 * wait for. A run's column is the phase the daemon computed; nothing here moves a card.
 */
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import type { Issue } from "../../shared/api/api.ts";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { useAction } from "../../shared/hooks.ts";
import {
  BOARD_COLUMNS,
  type BoardCard,
  type BoardFilter,
  boardCards,
  cardLine,
  cardState,
  DAY_MS,
  filterCards,
  filterFromStorage,
  NO_FILTER,
  partOfLine,
} from "../../shared/model/board.ts";
import { blockedReason, type FirstLevel, lookOf } from "../../shared/model/look.ts";
import { sameRepo } from "../../shared/model/places.ts";
import { routeHash } from "../../shared/model/route.ts";
import { workflowChoice } from "../../shared/model/runs.ts";
import { filterTasks, taskLine, taskState, type WorkTask, workTasks } from "../../shared/model/tasks.ts";
import { Notice } from "../../ui/notice.tsx";
import { StepDetailOf } from "../plans/step-detail.tsx";

const STORE = "metator.board";
const STATES = ["needs you", "working", "blocked"] as const;

function readFilter(): BoardFilter {
  try {
    return filterFromStorage(window.localStorage.getItem(STORE));
  } catch {
    return NO_FILTER;
  }
}
function saveFilter(f: BoardFilter): void {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(f));
  } catch {
    // A window without storage keeps the filter until it closes.
  }
}

/** The word and look of a card: one of the first level's four (`firstLevel`). */
function stateLook(state: FirstLevel): { glyph: string; tone: string; word: string } {
  const look = lookOf("first", state);
  return { glyph: look.glyph, tone: look.tone ?? "faint", word: state };
}

/** One tile of a column: a task (top level) or a subtask (a task's board). */
interface Tile {
  readonly key: string;
  readonly column: BoardCard["column"];
  readonly updatedAt: string;
  readonly needsYou: boolean;
  readonly escalated: boolean;
  readonly task?: WorkTask;
  readonly card?: BoardCard;
}

export function BoardScreen({
  task: openKey,
  onOpenRun,
}: {
  /** The task whose board is shown; none for the top level. */
  readonly task?: string | undefined;
  onOpenRun(runId: string): void;
}) {
  const { runs, repos, systemPlans, client } = useDaemon("runs", "repos", "systemPlans", "client");
  const names = repos.length > 0 ? repos.map((r) => r.name) : [undefined];
  const issues = usePolled(
    `board-issues:${names.join(",")}`,
    async () => {
      const all = await Promise.all(
        names.map(async (repo) => ({
          repo,
          issues: (await client.issues(repo)).data?.issues ?? ([] as Issue[]),
        })),
      );
      return { ok: true, data: all };
    },
    3000,
  );
  const action = useAction(issues.reload);
  const [filter, setFilterState] = useState<BoardFilter>(readFilter);
  const setFilter = (f: BoardFilter) => {
    setFilterState(f);
    saveFilter(f);
  };
  const [allDone, setAllDone] = useState(false);
  // Finished work is folded: Done shows its count until the person asks for it.
  const [showDone, setShowDone] = useState(false);
  // Each board (the top level, a task's) starts with Done folded.
  useEffect(() => {
    void openKey;
    setShowDone(false);
  }, [openKey]);
  const [dragged, setDragged] = useState(false);
  const now = Date.now();
  const cards = useMemo(
    () => boardCards({ runs, issues: issues.data ?? [], plans: systemPlans, now }),
    [runs, issues.data, systemPlans, now],
  );
  const tasks = useMemo(() => workTasks(cards, systemPlans), [cards, systemPlans]);
  const opened = openKey ? tasks.find((t) => t.key === openKey) : undefined;
  const hosts = [...new Set(cards.flatMap((c) => (c.host ? [c.host] : [])))].sort();
  const repoNames = [
    ...new Set([...repos.map((r) => r.name), ...cards.flatMap((c) => (c.repo ? [c.repo] : []))]),
  ];
  const tiles: Tile[] = opened
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
      }));
  const total = opened ? opened.subtasks.length : tasks.length;
  useEffect(() => {
    if (!dragged) return;
    const t = setTimeout(() => setDragged(false), 4000);
    return () => clearTimeout(t);
  }, [dragged]);
  const back = () => {
    window.location.hash = routeHash({ screen: "board" });
  };
  useEffect(() => {
    if (!openKey) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      // A step's detail has the keys while it is open: Escape closes it, not the task's board.
      if (document.querySelector("dialog[open]")) return;
      const field = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      if (e.key === "Escape" || (e.key === "Backspace" && !field)) {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // A step not started opens its detail (round 17): what it has, and "Plan this step".
  const [stepOpen, setStepOpen] = useState<{ planId: string; stepId: string; repo?: string | undefined }>();
  const openCard = (c: BoardCard) => {
    if (c.runId) onOpenRun(c.runId);
    else if (c.kind === "step" && c.planId && c.stepId)
      setStepOpen({ planId: c.planId, stepId: c.stepId, repo: c.planRepo });
    else if (c.kind === "step")
      window.location.hash = c.systemRunId
        ? routeHash({ screen: "run", runId: c.systemRunId, tab: "overview" })
        : routeHash({ screen: "overview", tab: "system" });
    else window.location.hash = routeHash({ screen: "backlog", ...(c.issueId ? { id: c.issueId } : {}) });
  };
  const openTask = (t: WorkTask) => {
    // A task made of steps opens its board; a run of its own opens its page; a backlog task the Backlog.
    if (t.kind === "system" || t.kind === "parent")
      window.location.hash = routeHash({ screen: "board", task: t.key });
    else if (t.head) openCard(t.head);
  };
  const start = (c: BoardCard) =>
    action.run(
      async () => {
        const known = await client.workflows(c.repo);
        const workflow = workflowChoice(
          (known.data?.workflows ?? []).map((w) => w.id),
          undefined,
        );
        if (!workflow)
          return { ok: false, error: { code: "USAGE", message: "this repository has no workflow" } };
        const r = await client.startIssue(c.issueId as string, { workflow }, c.repo);
        if (r.ok && r.data) onOpenRun(r.data.runId);
        return r;
      },
      { refused: "the run did not start" },
    );
  // Arrows move between cards (columns left and right, cards up and down), Enter opens.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (!el.dataset.card) return;
    if (e.key === "Enter") {
      el.click();
      return;
    }
    const col = Number(el.dataset.col);
    const row = Number(el.dataset.row);
    const all = [...document.querySelectorAll<HTMLElement>("[data-card]")];
    const at = (c: number) => all.filter((x) => Number(x.dataset.col) === c);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") next = at(col)[row + (e.key === "ArrowDown" ? 1 : -1)];
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const step = e.key === "ArrowRight" ? 1 : -1;
      for (let c = col + step; !next && c >= 0 && c < BOARD_COLUMNS.length; c += step) {
        const cs = at(c);
        next = cs[Math.min(row, cs.length - 1)];
      }
    } else return;
    e.preventDefault();
    next?.focus();
  };
  // On a task's board a blocked run says why, in one line (a pending step says what it waits for).
  const whyOf = (c: BoardCard): string | undefined => {
    if (!c.runId || cardState(c) !== "blocked") return undefined;
    return blockedReason({ run: runs.find((r) => r.runId === c.runId && sameRepo(r.repo, c.repo)) });
  };
  const toggle = <T,>(list: readonly T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const changed = filter.repos.length > 0 || filter.states.length > 0 || filter.host || filter.text;
  const ordered = (column: BoardCard["column"]) => {
    const mine = tiles.filter((t) => t.column === column);
    const rank = (t: Tile) => (t.needsYou ? 0 : t.escalated ? 1 : 2);
    const sorted = [...mine].sort(
      (a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key),
    );
    if (column !== "done" || allDone) return { shown: sorted, older: 0 };
    const recent = sorted.filter((t) => now - Date.parse(t.updatedAt) <= DAY_MS);
    return { shown: recent, older: sorted.length - recent.length };
  };
  return (
    <div className="board-screen" data-testid="board">
      {stepOpen ? (
        <StepDetailOf
          planId={stepOpen.planId}
          stepId={stepOpen.stepId}
          repo={stepOpen.repo}
          onClose={() => setStepOpen(undefined)}
        />
      ) : null}
      <section className="board-filters" aria-label="board filters">
        <nav className="breadcrumb" aria-label="where on the board">
          {opened ? (
            <>
              <a href={routeHash({ screen: "board" })} data-testid="board-back">
                Board
              </a>{" "}
              › <strong data-testid="board-task">{opened.title}</strong>
              {opened.progress ? (
                <span className="faint">
                  {" "}
                  · {opened.progress.done} of {opened.progress.of} steps done
                </span>
              ) : null}
              {opened.head?.runId ? (
                <>
                  <span className="faint"> · </span>
                  <a
                    href={routeHash({ screen: "run", runId: opened.head.runId, tab: "overview" })}
                    title="the task's own page: its plan and its flow"
                  >
                    its page ›
                  </a>
                </>
              ) : null}
            </>
          ) : (
            <strong>Board</strong>
          )}
        </nav>
        <fieldset className="chips" aria-label="repositories">
          {repoNames.map((r) => (
            <button
              key={r}
              type="button"
              className="chip"
              aria-pressed={filter.repos.includes(r)}
              onClick={() => setFilter({ ...filter, repos: toggle(filter.repos, r) })}
            >
              {r}
            </button>
          ))}
        </fieldset>
        <fieldset className="chips" aria-label="states">
          {STATES.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip ${lookOf("run", s).tone ?? ""}`}
              aria-pressed={filter.states.includes(s)}
              onClick={() => setFilter({ ...filter, states: toggle(filter.states, s) })}
            >
              {s}
            </button>
          ))}
        </fieldset>
        <select
          aria-label="host"
          value={filter.host ?? ""}
          onChange={(e) => setFilter({ ...filter, host: e.target.value || undefined })}
        >
          <option value="">any host</option>
          {hosts.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <input
          aria-label="search the board"
          placeholder="search"
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.target.value })}
        />
        {changed ? (
          <button type="button" className="ghost" onClick={() => setFilter(NO_FILTER)}>
            Clear
          </button>
        ) : null}
        <span className="spacer" />
        <span className="faint">
          {tiles.length} of {total} {opened ? "steps and runs" : "tasks"}
        </span>
      </section>
      <Notice {...action.notice} />
      {issues.error && !issues.data ? <div className="banner">{issues.error}</div> : null}
      {openKey && !opened ? (
        <div className="empty" data-testid="board-task-gone">
          <h2>This task is not on the board any more</h2>
          <p>
            <a href={routeHash({ screen: "board" })}>Back to all tasks</a>
          </p>
        </div>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: the arrows move between the cards inside
        <div className="board" onKeyDown={onKey}>
          <div className="board-head" aria-hidden="true">
            {BOARD_COLUMNS.map((c) => {
              const inCol = tiles.filter((t) => t.column === c.id);
              const needs = opened
                ? inCol.filter((t) => t.needsYou).length
                : inCol.reduce((n, t) => n + (t.task?.needsYou ?? 0), 0);
              const stuck = opened
                ? inCol.filter((t) => t.card?.runId !== undefined && cardState(t.card) === "blocked").length
                : inCol.reduce((n, t) => n + (t.task?.blocked ?? 0), 0);
              return (
                <div key={c.id} className="board-col-head" data-testid={`board-head-${c.id}`}>
                  <span>{c.label}</span> <span className="faint">{inCol.length}</span>
                  {needs > 0 ? <span className="amber"> · {needs} need you</span> : null}
                  {stuck > 0 ? <span className="red"> · {stuck} blocked</span> : null}
                </div>
              );
            })}
          </div>
          <div className="board-row">
            {BOARD_COLUMNS.map((col, ci) => {
              const all = ordered(col.id);
              const folded = col.id === "done" && !showDone;
              const shown = folded ? [] : all.shown;
              const older = folded ? 0 : all.older;
              return (
                <section
                  key={col.id}
                  className="board-col"
                  data-testid={`board-col-${col.id}`}
                  aria-label={col.label}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragged(true);
                  }}
                  onDrop={(e) => e.preventDefault()}
                >
                  {shown.map((t, ri) =>
                    t.task ? (
                      <TaskTile
                        key={t.key}
                        task={t.task}
                        col={ci}
                        row={ri}
                        onOpen={openTask}
                        onStart={start}
                        onDrag={() => setDragged(true)}
                      />
                    ) : t.card ? (
                      <CardTile
                        key={t.key}
                        card={t.card}
                        why={whyOf(t.card)}
                        col={ci}
                        row={ri}
                        onOpen={openCard}
                        onStart={start}
                        onDrag={() => setDragged(true)}
                      />
                    ) : null,
                  )}
                  {folded && all.shown.length + all.older > 0 ? (
                    <button
                      type="button"
                      className="ghost show-more"
                      data-testid="show-finished"
                      onClick={() => setShowDone(true)}
                    >
                      Show finished ({all.shown.length})
                    </button>
                  ) : shown.length === 0 ? (
                    <div className="board-empty faint">
                      {dragged
                        ? "Cards move by themselves: the engine sets a card's phase from its run's stage."
                        : "—"}
                    </div>
                  ) : dragged ? (
                    <div className="board-empty faint">
                      The engine decides the phase; a drop changes nothing.
                    </div>
                  ) : null}
                  {older > 0 ? (
                    <button type="button" className="ghost show-more" onClick={() => setAllDone(true)}>
                      show {older} more
                    </button>
                  ) : null}
                </section>
              );
            })}
          </div>
          {total === 0 && !opened ? (
            <div className="empty">
              <h2>Nothing on the board yet</h2>
              <p>A task in the Backlog, a run, or a system task appears here, in its phase.</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TaskTile({
  task: t,
  col,
  row,
  onOpen,
  onStart,
  onDrag,
}: {
  readonly task: WorkTask;
  readonly col: number;
  readonly row: number;
  onOpen(t: WorkTask): void;
  onStart(c: BoardCard): void;
  onDrag(): void;
}) {
  const look = stateLook(taskState(t));
  const opens = t.kind === "system" || t.kind === "parent";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card holds a button of its own (Start a run)
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDrag}
      className={`board-card task${t.needsYou > 0 ? " needs" : ""}${t.escalated > 0 ? " escalated" : ""}${t.state === "aborted" ? " aborted" : ""}`}
      data-card={t.key}
      data-col={col}
      data-row={row}
      data-testid={`task-${t.key}`}
      title={opens ? `${t.title}: open its board` : t.title}
      onClick={() => onOpen(t)}
      onKeyDown={(e) => {
        if (e.key === " ") {
          e.preventDefault();
          onOpen(t);
        }
      }}
    >
      <div className="card-top">
        <span className={`card-state ${look.tone}`}>
          {look.glyph} {look.word}
        </span>
      </div>
      <div className="card-title">{t.title}</div>
      <div className="card-line faint">{taskLine(t, false)}</div>
      {t.progress ? (
        <div className="card-part" data-testid="task-progress">
          {t.progress.done} of {t.progress.of} steps done{opens ? " · open its board ›" : ""}
        </div>
      ) : null}
      {t.kind === "issue" && t.head ? (
        <button
          type="button"
          className="card-action"
          onClick={(e) => {
            e.stopPropagation();
            if (t.head) onStart(t.head);
          }}
        >
          Start a run
        </button>
      ) : null}
    </div>
  );
}

function CardTile({
  card: c,
  why,
  col,
  row,
  onOpen,
  onStart,
  onDrag,
}: {
  readonly card: BoardCard;
  /** Why a blocked run stands still. */
  readonly why?: string | undefined;
  readonly col: number;
  readonly row: number;
  onOpen(c: BoardCard): void;
  onStart(c: BoardCard): void;
  onDrag(): void;
}) {
  const look = stateLook(cardState(c));
  const part = partOfLine(c);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card holds a button of its own (Start a run)
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDrag}
      className={`board-card${c.needsYou ? " needs" : ""}${c.escalated ? " escalated" : ""}${c.state === "aborted" ? " aborted" : ""}${c.kind === "step" ? " pending" : ""}`}
      data-card={c.key}
      data-col={col}
      data-row={row}
      data-testid={`card-${c.kind}-${c.runId ?? c.issueId ?? c.key}`}
      title={c.title}
      onClick={() => onOpen(c)}
      onKeyDown={(e) => {
        if (e.key === " ") {
          e.preventDefault();
          onOpen(c);
        }
      }}
    >
      <div className="card-top">
        <span className={`card-state ${look.tone}`}>
          {look.glyph} {look.word}
        </span>
      </div>
      <div className="card-title">{c.title}</div>
      <div className="card-line faint">{cardLine(c)}</div>
      {part ? <div className="card-part">{part}</div> : null}
      {c.waitsFor && c.waitsFor.length > 0 ? (
        <div className="card-waits faint">waits for: {c.waitsFor.join(", ")}</div>
      ) : null}
      {why ? <div className="card-waits red">{why}</div> : null}
      {c.kind === "issue" ? (
        <button
          type="button"
          className="card-action"
          onClick={(e) => {
            e.stopPropagation();
            onStart(c);
          }}
        >
          Start a run
        </button>
      ) : null}
    </div>
  );
}
