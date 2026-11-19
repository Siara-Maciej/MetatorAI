/**
 * The sidebar: the work as parent tasks. One row per task (a system task, a run with child runs,
 * a standalone run), with one state word, its progress and how many of its steps need the
 * person; what needs the person sorts first. A task expands to its own tree: its steps and child
 * runs by repository (pending steps with what they wait for); a standalone run expands to its
 * panes. Home shows the decisions one at a time; the sidebar only counts them. Every row reads
 * one of the first level's four words (`firstLevel`); no ids, hosts or ages. Finished tasks are
 * hidden behind "Show finished (N)". The places are at the bottom: Board, Terminals, Backlog,
 * and Settings, which holds the System and the Reviews.
 */
import type { ReactNode } from "react";
import { useState } from "react";
import { type BoardCard, boardCards } from "../board.ts";
import { useDaemon } from "../daemon.tsx";
import {
  finishedText,
  firstLevel,
  isFinished,
  lookOf,
  type NeedRow,
  paneLabel,
  paneStateOf,
  panesOfRun,
  plural,
  type Route,
  type Run,
  routeHash,
  runLine,
  runWithPanes,
  sameRepo,
} from "../model.ts";
import { byAttentionFirst, subtasksByRepo, taskLine, taskState, type WorkTask, workTasks } from "../tasks.ts";
import { Glyph } from "./glyph.tsx";
import { moveInList } from "./list-keys.ts";

/** The places that are not a run, in the order of the sidebar's bottom. */
const PLACES: readonly {
  readonly route: Route;
  readonly label: string;
  readonly glyph: string;
  /** The screens the place holds (Settings: the System and the Reviews too). */
  readonly holds: readonly Route["screen"][];
}[] = [
  { route: { screen: "board" }, label: "Board", glyph: "▥", holds: ["board"] },
  { route: { screen: "grid" }, label: "Terminals", glyph: "▦", holds: ["grid"] },
  { route: { screen: "backlog" }, label: "Backlog", glyph: "☷", holds: ["backlog"] },
  { route: { screen: "settings" }, label: "Settings", glyph: "⚙", holds: ["settings", "overview", "mrs"] },
];

/** One row of the sidebar: glyph, name, the state's word, one dim line. */
export function Row({
  glyph,
  name,
  sub,
  word,
  tone,
  current,
  nested = false,
  className = "",
  ...rest
}: {
  readonly glyph: ReactNode;
  readonly name: ReactNode;
  readonly sub?: ReactNode;
  readonly word?: string | undefined;
  readonly tone?: string | undefined;
  readonly current?: boolean | undefined;
  readonly nested?: boolean;
  readonly className?: string;
  readonly title?: string | undefined;
  readonly "data-testid"?: string | undefined;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={`row${nested ? " nested" : ""} ${className}`}
      aria-current={current ? "true" : undefined}
      {...rest}
    >
      {glyph}
      <span className="text">
        <span className="title">{name}</span>
        {sub ? <span className="sub">{sub}</span> : null}
      </span>
      {word ? <span className={`word kind ${tone ?? ""}`}>{word}</span> : null}
    </button>
  );
}

export function Sidebar({
  route,
  needs,
  onRun,
  onInbox,
  onNew,
  onForm,
}: {
  readonly route: Route;
  /** Everything that needs the person (model.ts `needsQueue`). */
  readonly needs: readonly NeedRow[];
  onRun(run: Run, pane?: string): void;
  onInbox(): void;
  /** Opens the agent that starts a run: the person describes it. */
  onNew(): void;
  /** The form: workflow, autonomy, host and worktree chosen by hand. */
  onForm(): void;
}) {
  const { runs, panesOf, down, unreadable, systemPlans } = useDaemon();
  const [showFinished, setShowFinished] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const current = route.screen === "run" ? route.runId : undefined;
  const stateOf = (r: Run) =>
    runWithPanes(
      r,
      panesOfRun(panesOf(r.repo), r.runId).map((p) => paneStateOf(p)),
    );
  // The work as parent tasks (tasks.ts), from the same cards the Board shows.
  const tasks = byAttentionFirst(
    workTasks(boardCards({ runs, issues: [], plans: systemPlans, now: Date.now() }), systemPlans),
  );
  const isDone = (t: WorkTask) => t.column === "done";
  const open = tasks.filter((t) => !isDone(t));
  const done = tasks.filter(isDone);
  const runOf = (c: BoardCard) =>
    c.runId ? runs.find((r) => r.runId === c.runId && sameRepo(r.repo, c.repo)) : undefined;
  const holds = (t: WorkTask) =>
    current !== undefined && (t.head?.runId === current || t.subtasks.some((c) => c.runId === current));
  const expandedNow = (t: WorkTask) => expanded[t.key] ?? holds(t);
  const taskRows = (t: WorkTask) => {
    const headRun = t.head ? runOf(t.head) : undefined;
    // A run of its own reads its panes too: a conductor at work is working.
    const word =
      t.kind === "run" && headRun && !isFinished(headRun) ? firstLevel(stateOf(headRun)) : taskState(t);
    const look = lookOf("first", word);
    const open = expandedNow(t);
    const kids =
      t.kind === "run" && headRun && !isFinished(headRun)
        ? panesOfRun(panesOf(headRun.repo), headRun.runId)
        : [];
    const canOpen = t.subtasks.length > 0 || kids.length > 0;
    return (
      <div key={t.key} className="task" data-testid={`side-task-${t.key}`}>
        <div className="task-row">
          {canOpen ? (
            <button
              type="button"
              className="ghost expander"
              aria-expanded={open}
              aria-label={`${open ? "fold" : "unfold"} ${t.title}`}
              onClick={() => setExpanded({ ...expanded, [t.key]: !open })}
            >
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span className="expander" />
          )}
          <Row
            glyph={<Glyph kind="first" state={word} />}
            name={t.title}
            sub={t.kind === "run" && headRun ? runLine(headRun) : taskLine(t)}
            word={word}
            tone={look.tone}
            current={t.head?.runId !== undefined && t.head.runId === current}
            title={headRun && isFinished(headRun) ? `${t.title}\n${finishedText(headRun)}` : t.title}
            onClick={() => {
              if (headRun) onRun(headRun, headRun.terminalAsk);
              else if (t.kind === "system" || t.kind === "parent")
                window.location.hash = routeHash({ screen: "board", task: t.key });
            }}
          />
        </div>
        {open && t.kind === "run"
          ? kids.map((p) => {
              // A pane on the first level: it asks (needs you), it works, or nothing (its finer
              // word, idle or exited, is in the run's terminal).
              const st = paneStateOf(p);
              const pw = st === "asks" ? "needs you" : st === "working" ? "working" : undefined;
              return (
                <Row
                  key={p.id}
                  className="pane-row"
                  nested
                  glyph={<Glyph kind="first" state={pw} />}
                  name={paneLabel(p)}
                  word={pw}
                  tone={pw ? lookOf("first", pw).tone : "faint"}
                  current={headRun?.runId === current && route.screen === "run" && route.pane === p.id}
                  title={`${p.id} · ${p.state?.reason ?? ""}`}
                  onClick={() => headRun && onRun(headRun, p.id)}
                />
              );
            })
          : null}
        {open && t.kind !== "run"
          ? subtasksByRepo(t).map((g) => (
              <div key={g.repo || "."} className="task-repo">
                <div className="repo-name">{g.repo || "this repository"}</div>
                {g.cards.map((c) => {
                  const r = runOf(c);
                  const st = r ? firstLevel(stateOf(r)) : firstLevel(c.state);
                  return (
                    <Row
                      key={c.key}
                      nested
                      className={c.kind === "step" ? "pending-step" : ""}
                      glyph={<Glyph kind="first" state={st} />}
                      name={c.title}
                      sub={
                        r
                          ? [
                              c.step ? `step ${c.step.at} of ${c.step.of}` : undefined,
                              isFinished(r) ? undefined : r.stage,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : c.waitsFor && c.waitsFor.length > 0
                            ? `not started · waits for ${c.waitsFor.join(", ")}`
                            : "not started · can start"
                      }
                      word={st}
                      tone={lookOf("first", st).tone}
                      current={r !== undefined && r.runId === current}
                      title={c.title}
                      onClick={() => {
                        if (r) onRun(r, r.terminalAsk);
                        else if (c.systemRunId)
                          window.location.hash = routeHash({
                            screen: "run",
                            runId: c.systemRunId,
                            tab: "overview",
                          });
                      }}
                    />
                  );
                })}
              </div>
            ))
          : null}
      </div>
    );
  };
  return (
    <aside className="sessions" aria-label="runs" onKeyDown={(e) => moveInList(e, ".row")}>
      <div className="list">
        {down ? (
          <div className="section">No daemon: nothing to list</div>
        ) : (
          <>
            <button type="button" className="section needs-head" data-testid="needs-count" onClick={onInbox}>
              <Glyph kind="first" state={needs.length > 0 ? "needs you" : undefined} />
              Needs you · {needs.length}
            </button>
            <section className="tasks" aria-label="tasks">
              <div className="section">Tasks · {open.length}</div>
              {open.map((t) => taskRows(t))}
              {open.length === 0 ? <div className="quiet">No task is open.</div> : null}
            </section>
            {done.length > 0 ? (
              <div className="tasks">
                <button
                  type="button"
                  className="section"
                  aria-expanded={showFinished}
                  data-testid="show-finished"
                  onClick={() => setShowFinished(!showFinished)}
                >
                  <Glyph kind="first" state="done" />
                  {showFinished ? `Hide finished (${done.length})` : `Show finished (${done.length})`}
                </button>
                {showFinished ? done.map((t) => taskRows(t)) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
      {unreadable.length > 0 ? (
        <details className="unreadable" data-testid="unreadable">
          <summary className="amber">{plural(unreadable.length, "run")} cannot be read</summary>
          <ul>
            {unreadable.map((u) => (
              <li key={`${u.repo ?? ""}:${u.runId}`}>
                <span className="mono">{u.runId}</span>
                {u.repo ? ` · ${u.repo}` : ""}: {u.message}. Restore <code>{u.file}</code>, or delete the
                run's directory.
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <nav className="places" aria-label="places">
        {PLACES.map((p) => (
          <a
            key={p.label}
            className="row place"
            href={routeHash(p.route)}
            aria-current={p.holds.includes(route.screen) ? "page" : undefined}
          >
            <span className="g faint" aria-hidden="true">
              {p.glyph}
            </span>
            <span className="text">
              <span className="title">{p.label}</span>
            </span>
          </a>
        ))}
      </nav>
      <div className="new-run">
        <button
          type="button"
          className="primary"
          title="Describe what to do to the agent; it starts the run (key n)"
          disabled={down}
          onClick={onNew}
        >
          + New run
        </button>
        <button
          type="button"
          aria-label="New run from the form"
          title="The form: workflow, autonomy, host, worktree"
          disabled={down}
          onClick={onForm}
        >
          Form…
        </button>
      </div>
    </aside>
  );
}
