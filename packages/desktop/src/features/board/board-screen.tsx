/**
 * The Board in two levels. The top level shows only parent tasks (a system task, a run with child
 * runs, a standalone run, a backlog task), each once, in the column of its own phase, with its
 * progress and how many of its steps need the person. A task opens its own board: the same
 * columns with its steps and child runs across repositories, pending steps in To do with what they
 * wait for. A run's column is the phase the daemon computed; nothing here moves a card.
 *
 * The screen only lays its parts out (ADR-0113): what it keeps is the Board store (`state.ts`),
 * and each part reads only the value it draws, so a filter draws its own control and the columns
 * whose cards changed, and a tile draws again only when its own task changed.
 */
import { type KeyboardEvent, useEffect, useLayoutEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Issue } from "../../shared/api/api.ts";
import { useDaemon, useDaemonStore, usePolled } from "../../shared/daemon/daemon.tsx";
import { BOARD_COLUMNS, type BoardCard, cardState, NO_FILTER } from "../../shared/model/board.ts";
import { lookOf } from "../../shared/model/look.ts";
import { routeHash } from "../../shared/model/route.ts";
import { navigate } from "../../shared/navigation.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { StepDetailOf } from "../plans/step-detail.tsx";
import { useOpenRun } from "../runs/open-run.ts";
import { readFilter } from "./filter.ts";
import {
  Board,
  type BoardState,
  columnOf,
  filterChanged,
  openedOf,
  STATES,
  tilesOf,
  totalOf,
  useBoard,
  useBoardApi,
  whyOf,
} from "./state.ts";
import { CardTile, TaskTile } from "./tiles.tsx";

export function BoardScreen({
  task: openKey,
}: {
  /** The task whose board is shown; none for the top level. */
  readonly task?: string | undefined;
}) {
  const daemon = useDaemonStore();
  const openRun = useOpenRun();
  return (
    <ScopeProvider
      store={Board}
      init={{ daemon, openKey, filter: readFilter(), openRun: (runId: string) => openRun(runId) }}
    >
      <RouteToTask openKey={openKey} />
      <FeedBoard />
      <BackKeys />
      <div className="board-screen" data-testid="board">
        <OpenStep />
        <section className="board-filters" aria-label="board filters">
          <Breadcrumb />
          <RepoChips />
          <StateChips />
          <HostSelect />
          <SearchBoard />
          <ClearFilter />
          <span className="spacer" />
          <TileCount />
        </section>
        <BoardNotice />
        <IssuesError />
        <BoardBody />
      </div>
    </ScopeProvider>
  );
}

/** The route's task: each board (the top level, a task's) starts with Done folded. */
function RouteToTask({ openKey }: { readonly openKey: string | undefined }) {
  const routeTo = useBoard((s) => s.routeTo);
  useEffect(() => routeTo(openKey), [openKey, routeTo]);
  return null;
}

const NO_ISSUES: readonly { readonly repo: string | undefined; readonly issues: readonly Issue[] }[] = [];

/**
 * What the board is made of, handed to its store when it changes: the daemon's runs and plans and
 * every repository's tasks. The store works out the cards and tasks once for all the parts (as the
 * daemon's own store is published), so each part selects its piece of one answer.
 */
function FeedBoard() {
  const { runs, repos, systemPlans, client } = useDaemon("runs", "repos", "systemPlans", "client");
  const names = repos.length > 0 ? repos.map((r) => r.name) : [undefined];
  const issuesKey = `board-issues:${names.join(",")}`;
  const issues = usePolled(
    issuesKey,
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
  const feed = useBoard((s) => s.feed);
  const { data, error } = issues;
  useLayoutEffect(
    () =>
      feed({
        runs,
        plans: systemPlans,
        repos: repos.map((r) => r.name),
        issues: data ?? NO_ISSUES,
        issuesKey,
        issuesError: data ? undefined : error,
      }),
    [feed, runs, systemPlans, repos, data, error, issuesKey],
  );
  return null;
}

/** On a task's board, Escape (or Backspace outside a field) goes back to all tasks. */
function BackKeys() {
  const open = useBoard((s) => s.openKey !== undefined);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      // A step's detail has the keys while it is open: Escape closes it, not the task's board.
      if (document.querySelector("dialog[open]")) return;
      const field = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      if (e.key === "Escape" || (e.key === "Backspace" && !field)) {
        e.preventDefault();
        navigate({ screen: "board" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return null;
}

/** A step not started opens its detail (round 17): what it has, and "Plan this step". */
function OpenStep() {
  const step = useBoard((s) => s.stepOpen);
  const closeStep = useBoard((s) => s.closeStep);
  return step ? (
    <StepDetailOf planId={step.planId} stepId={step.stepId} repo={step.repo} onClose={closeStep} />
  ) : null;
}

function Breadcrumb() {
  const opened = useBoard(openedOf);
  return (
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
  );
}

/** The repositories the daemon serves and the ones a card names. */
const repoNamesOf = (s: BoardState): readonly string[] => [
  ...new Set([...s.repos, ...s.cards.flatMap((c) => (c.repo ? [c.repo] : []))]),
];
const hostsOf = (s: BoardState): readonly string[] =>
  [...new Set(s.cards.flatMap((c) => (c.host ? [c.host] : [])))].sort();

function RepoChips() {
  const names = useBoard(useShallow(repoNamesOf));
  return (
    <fieldset className="chips" aria-label="repositories">
      {names.map((r) => (
        <RepoChip key={r} repo={r} />
      ))}
    </fieldset>
  );
}

/** One repository's chip: it hears only whether it is pressed. */
export function RepoChip({ repo }: { readonly repo: string }) {
  const pressed = useBoard((s) => s.filter.repos.includes(repo));
  const toggleRepo = useBoard((s) => s.toggleRepo);
  return (
    <Button className="chip" aria-pressed={pressed} onClick={() => toggleRepo(repo)}>
      {repo}
    </Button>
  );
}

function StateChips() {
  return (
    <fieldset className="chips" aria-label="states">
      {STATES.map((s) => (
        <StateChip key={s} state={s} />
      ))}
    </fieldset>
  );
}

function StateChip({ state }: { readonly state: (typeof STATES)[number] }) {
  const pressed = useBoard((s) => s.filter.states.includes(state));
  const toggleState = useBoard((s) => s.toggleState);
  return (
    <Button
      className={`chip ${lookOf("run", state).tone ?? ""}`}
      aria-pressed={pressed}
      onClick={() => toggleState(state)}
    >
      {state}
    </Button>
  );
}

function HostSelect() {
  const hosts = useBoard(useShallow(hostsOf));
  const host = useBoard((s) => s.filter.host ?? "");
  const setHost = useBoard((s) => s.setHost);
  return (
    <select aria-label="host" value={host} onChange={(e) => setHost(e.target.value || undefined)}>
      <option value="">any host</option>
      {hosts.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </select>
  );
}

export function SearchBoard() {
  const text = useBoard((s) => s.filter.text);
  const setText = useBoard((s) => s.setText);
  return (
    <input
      aria-label="search the board"
      placeholder="search"
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
  );
}

function ClearFilter() {
  const changed = useBoard((s) => filterChanged(s.filter));
  const api = useBoardApi();
  return changed ? (
    <Button variant="ghost" onClick={() => api.getState().setFilter(NO_FILTER)}>
      Clear
    </Button>
  ) : null;
}

function TileCount() {
  const shown = useBoard((s) => tilesOf(s).length);
  const total = useBoard(totalOf);
  const opened = useBoard((s) => openedOf(s) !== undefined);
  return (
    <span className="faint">
      {shown} of {total} {opened ? "steps and runs" : "tasks"}
    </span>
  );
}

function BoardNotice() {
  const notice = useBoard((s) => s.notice);
  const closeNotice = useBoard((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
}

function IssuesError() {
  const error = useBoard((s) => s.issuesError);
  return error ? <div className="banner">{error}</div> : null;
}

function BoardBody() {
  const gone = useBoard((s) => s.openKey !== undefined && openedOf(s) === undefined);
  return gone ? (
    <div className="empty" data-testid="board-task-gone">
      <h2>This task is not on the board any more</h2>
      <p>
        <a href={routeHash({ screen: "board" })}>Back to all tasks</a>
      </p>
    </div>
  ) : (
    // biome-ignore lint/a11y/noStaticElementInteractions: the arrows move between the cards inside
    <div className="board" onKeyDown={moveAmongCards}>
      <div className="board-head" aria-hidden="true">
        {BOARD_COLUMNS.map((c) => (
          <ColumnHead key={c.id} column={c.id} label={c.label} />
        ))}
      </div>
      <div className="board-row">
        {BOARD_COLUMNS.map((c, ci) => (
          <BoardColumn key={c.id} column={c.id} label={c.label} index={ci} />
        ))}
      </div>
      <EmptyBoard />
    </div>
  );
}

/** Arrows move between cards (columns left and right, cards up and down), Enter opens. */
function moveAmongCards(e: KeyboardEvent<HTMLDivElement>) {
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
}

type Column = BoardCard["column"];

/** A column's head: how many tiles, how many need you, how many are blocked. */
function ColumnHead({ column, label }: { readonly column: Column; readonly label: string }) {
  const count = useBoard((s) => tilesOf(s).filter((t) => t.column === column).length);
  const needs = useBoard((s) => {
    const inCol = tilesOf(s).filter((t) => t.column === column);
    return openedOf(s)
      ? inCol.filter((t) => t.needsYou).length
      : inCol.reduce((n, t) => n + (t.task?.needsYou ?? 0), 0);
  });
  const stuck = useBoard((s) => {
    const inCol = tilesOf(s).filter((t) => t.column === column);
    return openedOf(s)
      ? inCol.filter((t) => t.card?.runId !== undefined && cardState(t.card) === "blocked").length
      : inCol.reduce((n, t) => n + (t.task?.blocked ?? 0), 0);
  });
  return (
    <div className="board-col-head" data-testid={`board-head-${column}`}>
      <span>{label}</span> <span className="faint">{count}</span>
      {needs > 0 ? <span className="amber"> · {needs} need you</span> : null}
      {stuck > 0 ? <span className="red"> · {stuck} blocked</span> : null}
    </div>
  );
}

/** The keys of a column's tiles, in order, as one string: the column draws again when they change. */
const keysOf = (tiles: readonly { readonly key: string }[]): string => tiles.map((t) => t.key).join("\n");
const split = (joined: string): readonly string[] => (joined === "" ? [] : joined.split("\n"));

/** One column: its tiles in order; Done folded until asked, with its older work behind "show more". */
export function BoardColumn({
  column,
  label,
  index,
}: {
  readonly column: Column;
  readonly label: string;
  readonly index: number;
}) {
  const keys = split(useBoard((s) => keysOf(columnOf(s, column, Date.now()).shown)));
  const older = useBoard((s) => columnOf(s, column, Date.now()).older);
  const folded = useBoard((s) => column === "done" && !s.showDone);
  const dragged = useBoard((s) => s.dragged);
  const api = useBoardApi();
  const shown = folded ? [] : keys;
  return (
    <section
      className="board-col"
      data-testid={`board-col-${column}`}
      aria-label={label}
      onDragOver={(e) => {
        e.preventDefault();
        api.getState().drag();
      }}
      onDrop={(e) => e.preventDefault()}
    >
      {shown.map((key, ri) => (
        <BoardTile key={key} tileKey={key} col={index} row={ri} />
      ))}
      {folded && keys.length + older > 0 ? (
        <Button
          variant="ghost"
          className="show-more"
          data-testid="show-finished"
          onClick={() => api.getState().showFinished()}
        >
          Show finished ({keys.length})
        </Button>
      ) : shown.length === 0 ? (
        <div className="board-empty faint">
          {dragged ? "Cards move by themselves: the engine sets a card's phase from its run's stage." : "—"}
        </div>
      ) : dragged ? (
        <div className="board-empty faint">The engine decides the phase; a drop changes nothing.</div>
      ) : null}
      {!folded && older > 0 ? (
        <Button variant="ghost" className="show-more" onClick={() => api.getState().showAllDone()}>
          show {older} more
        </Button>
      ) : null}
    </section>
  );
}

/** One tile: its own task (top level) or card (a task's board), the same object while it did not change. */
export function BoardTile({
  tileKey,
  col,
  row,
}: {
  readonly tileKey: string;
  readonly col: number;
  readonly row: number;
}) {
  const task = useBoard((s) => tilesOf(s).find((t) => t.key === tileKey)?.task);
  const card = useBoard((s) => tilesOf(s).find((t) => t.key === tileKey)?.card);
  const why = useBoard((s) => (card ? whyOf(s.runs, card) : undefined));
  const { openTask, openCard, start, drag } = useBoardApi().getState();
  if (task)
    return (
      <TaskTile
        task={task}
        col={col}
        row={row}
        onOpen={openTask}
        onStart={(c) => void start(c)}
        onDrag={drag}
      />
    );
  if (card)
    return (
      <CardTile
        card={card}
        why={why}
        col={col}
        row={row}
        onOpen={openCard}
        onStart={(c) => void start(c)}
        onDrag={drag}
      />
    );
  return null;
}

function EmptyBoard() {
  const empty = useBoard((s) => totalOf(s) === 0 && openedOf(s) === undefined);
  return empty ? (
    <div className="empty">
      <h2>Nothing on the board yet</h2>
      <p>A task in the Backlog, a run, or a system task appears here, in its phase.</p>
    </div>
  ) : null;
}
