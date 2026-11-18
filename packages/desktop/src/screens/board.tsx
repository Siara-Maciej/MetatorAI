/**
 * The Board: every piece of work by phase (To do · Planning · In progress · Review · Done). A
 * run's column is the phase the daemon computed (board.ts); nothing here moves a card: the engine
 * decides. Filters above it are kept per viewer in the window's storage.
 */
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import type { Issue } from "../api.ts";
import {
  BOARD_COLUMNS,
  type BoardCard,
  type BoardFilter,
  boardCards,
  cardLine,
  columnCards,
  columnCounts,
  filterCards,
  filterFromStorage,
  NO_FILTER,
  parentOptions,
  partOfLine,
  swimlanes,
} from "../board.ts";
import { Notice } from "../components/common.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { duration, lookOf, routeHash, workflowChoice } from "../model.ts";

const STORE = "metator.board";
const STATES = ["needs you", "escalated", "working"] as const;

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

/** The word and look of a card's state: a run's own word, or what a task without a run is. */
function stateLook(c: BoardCard): { glyph: string; tone: string; word: string } {
  if (c.state === "todo") return { glyph: "○", tone: "faint", word: "to do" };
  if (c.state === "proposed") return { glyph: "?", tone: "amber", word: "proposed" };
  if (c.state === "pending")
    return { glyph: "◌", tone: "faint", word: c.waitsFor?.length ? "waits" : "can start" };
  const look = lookOf("run", c.state);
  return { glyph: look.glyph, tone: look.tone ?? "faint", word: c.state };
}

export function BoardScreen({ onOpenRun }: { onOpenRun(runId: string): void }) {
  const { runs, repos, systemPlans, client } = useDaemon();
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
  const [dragged, setDragged] = useState(false);
  const now = Date.now();
  const cards = useMemo(
    () => boardCards({ runs, issues: issues.data ?? [], plans: systemPlans, now }),
    [runs, issues.data, systemPlans, now],
  );
  const parents = parentOptions(cards);
  const hosts = [...new Set(cards.flatMap((c) => (c.host ? [c.host] : [])))].sort();
  const repoNames = [
    ...new Set([...repos.map((r) => r.name), ...cards.flatMap((c) => (c.repo ? [c.repo] : []))]),
  ];
  const shown = filterCards(cards, filter);
  const lanes = filter.grouped ? swimlanes(shown) : [{ key: "all", label: "", cards: shown }];
  useEffect(() => {
    if (!dragged) return;
    const t = setTimeout(() => setDragged(false), 4000);
    return () => clearTimeout(t);
  }, [dragged]);

  const open = (c: BoardCard) => {
    if (c.runId) onOpenRun(c.runId);
    else if (c.kind === "step")
      window.location.hash = c.systemRunId
        ? routeHash({ screen: "run", runId: c.systemRunId, tab: "plan" })
        : routeHash({ screen: "overview", tab: "system" });
    else window.location.hash = routeHash({ screen: "backlog" });
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
    const lane = Number(el.dataset.lane);
    const col = Number(el.dataset.col);
    const row = Number(el.dataset.row);
    const all = [...document.querySelectorAll<HTMLElement>("[data-card]")];
    const at = (l: number, c: number) =>
      all.filter((x) => Number(x.dataset.lane) === l && Number(x.dataset.col) === c);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      next = at(lane, col)[row + step];
      // Past a lane's end: the same column of the next (or previous) lane.
      for (let l = lane + step; !next && l >= 0 && l < lanes.length; l += step) {
        const cards = at(l, col);
        next = step > 0 ? cards[0] : cards.at(-1);
      }
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const step = e.key === "ArrowRight" ? 1 : -1;
      for (let c = col + step; !next && c >= 0 && c < BOARD_COLUMNS.length; c += step) {
        const cards = at(lane, c);
        next = cards[Math.min(row, cards.length - 1)];
      }
    } else return;
    e.preventDefault();
    next?.focus();
  };
  const toggle = <T,>(list: readonly T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const changed =
    filter.repos.length > 0 ||
    filter.parent ||
    filter.states.length > 0 ||
    filter.host ||
    filter.text ||
    filter.grouped;
  return (
    <div className="board-screen" data-testid="board">
      <section className="board-filters" aria-label="board filters">
        <strong>Board</strong>
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
        <select
          aria-label="parent task"
          value={filter.parent ?? ""}
          onChange={(e) => setFilter({ ...filter, parent: e.target.value || undefined })}
        >
          <option value="">every task</option>
          {parents.map((p) => (
            <option key={p.key} value={p.key}>
              only {p.label}
            </option>
          ))}
        </select>
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
        <label className="group-by">
          <input
            type="checkbox"
            checked={filter.grouped}
            onChange={(e) => setFilter({ ...filter, grouped: e.target.checked })}
          />{" "}
          group by parent task
        </label>
        {changed ? (
          <button type="button" className="ghost" onClick={() => setFilter(NO_FILTER)}>
            Clear
          </button>
        ) : null}
        <span className="spacer" />
        <span className="faint">
          {shown.length} of {cards.length}
        </span>
      </section>
      <Notice {...action.notice} />
      {issues.error && !issues.data ? <div className="banner">{issues.error}</div> : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the arrows move between the cards inside */}
      <div className="board" onKeyDown={onKey}>
        <div className="board-head" aria-hidden="true">
          {BOARD_COLUMNS.map((c) => {
            const { shown: inCol } = columnCards(shown, c.id, now, true);
            const n = columnCounts(inCol);
            return (
              <div key={c.id} className="board-col-head" data-testid={`board-head-${c.id}`}>
                <span>{c.label}</span> <span className="faint">{n.total}</span>
                {n.needsYou > 0 ? <span className="amber"> · {n.needsYou} need you</span> : null}
                {n.escalated > 0 ? <span className="red"> · {n.escalated} escalated</span> : null}
              </div>
            );
          })}
        </div>
        {lanes.map((lane, li) => (
          <section key={lane.key} className="board-lane" aria-label={lane.label || "all work"}>
            {filter.grouped ? (
              <h3 className="lane-title">
                {lane.label} <span className="faint">{lane.cards.length}</span>
              </h3>
            ) : null}
            <div className="board-row">
              {BOARD_COLUMNS.map((col, ci) => {
                const { shown: inCol, older } = columnCards(lane.cards, col.id, now, allDone);
                return (
                  <section
                    key={col.id}
                    className="board-col"
                    data-testid={`board-col-${col.id}${filter.grouped ? `-${li}` : ""}`}
                    aria-label={`${col.label}${filter.grouped ? ` · ${lane.label}` : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragged(true);
                    }}
                    onDrop={(e) => e.preventDefault()}
                  >
                    {inCol.map((c, ri) => {
                      const look = stateLook(c);
                      const part = partOfLine(c);
                      return (
                        // biome-ignore lint/a11y/useSemanticElements: a card holds a button of its own (Start a run)
                        <div
                          key={c.key}
                          role="button"
                          tabIndex={0}
                          draggable
                          onDragStart={() => setDragged(true)}
                          className={`board-card${c.needsYou ? " needs" : ""}${c.escalated ? " escalated" : ""}${c.state === "aborted" ? " aborted" : ""}${c.kind === "step" ? " pending" : ""}`}
                          data-card={c.key}
                          data-lane={li}
                          data-col={ci}
                          data-row={ri}
                          data-testid={`card-${c.kind}-${c.runId ?? c.issueId ?? c.key}`}
                          title={c.title}
                          onClick={() => open(c)}
                          onKeyDown={(e) => {
                            // Enter is the board's (it opens); a space opens too, as on a button.
                            if (e.key === " ") {
                              e.preventDefault();
                              open(c);
                            }
                          }}
                        >
                          <div className="card-top">
                            <span className={`card-state ${look.tone}`}>
                              {look.glyph} {look.word}
                            </span>
                            <span className="faint">{duration(c.ageMs)}</span>
                          </div>
                          <div className="card-title">{c.title}</div>
                          <div className="card-line faint">{cardLine(c)}</div>
                          {part ? <div className="card-part">{part}</div> : null}
                          {c.waitsFor && c.waitsFor.length > 0 ? (
                            <div className="card-waits faint">waits for: {c.waitsFor.join(", ")}</div>
                          ) : null}
                          {c.kind === "issue" ? (
                            <button
                              type="button"
                              className="card-action"
                              onClick={(e) => {
                                e.stopPropagation();
                                void start(c);
                              }}
                            >
                              Start a run
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                    {inCol.length === 0 ? (
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
          </section>
        ))}
        {cards.length === 0 ? (
          <div className="empty">
            <h2>Nothing on the board yet</h2>
            <p>A task in the Backlog, a run, or a system plan's steps appear here, each in its phase.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
