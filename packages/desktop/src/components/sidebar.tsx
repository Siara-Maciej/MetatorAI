/**
 * The sidebar: the work as parent tasks. One row per task (a system task, a run with child runs,
 * a standalone run), with one state word, its progress and how many of its steps need the
 * person; what needs the person sorts first. A task expands to its own tree: its steps and child
 * runs by repository (pending steps with what they wait for); a standalone run expands to its
 * panes. The Inbox lists every decision; the sidebar only counts them. The places are at the bottom.
 */
import type { ReactNode } from "react";
import { useState } from "react";
import { type BoardCard, boardCards } from "../board.ts";
import { useDaemon } from "../daemon.tsx";
import {
  finishedText,
  isFinished,
  isNews,
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
  seenKey,
} from "../model.ts";
import { byAttentionFirst, subtasksByRepo, taskLine, type WorkTask, workTasks } from "../tasks.ts";
import { Glyph } from "./glyph.tsx";
import { moveInList } from "./list-keys.ts";

/** The places that are not a run, in the order of the sidebar's bottom. */
const PLACES: readonly { readonly route: Route; readonly label: string; readonly glyph: string }[] = [
  { route: { screen: "grid" }, label: "Terminals", glyph: "▦" },
  { route: { screen: "board" }, label: "Board", glyph: "▥" },
  { route: { screen: "backlog" }, label: "Backlog", glyph: "☷" },
  { route: { screen: "mrs" }, label: "Reviews", glyph: "⇄" },
  { route: { screen: "overview", tab: "daemon" }, label: "Overview", glyph: "◎" },
  { route: { screen: "settings" }, label: "Settings", glyph: "⚙" },
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
  const { runs, panesOf, down, unreadable, seen, systemPlans } = useDaemon();
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
    const quiet = t.state === "done" && headRun !== undefined && !isNews(headRun, seen[seenKey(headRun)]);
    const word = t.state === "todo" || t.state === "pending" || t.state === "proposed" ? undefined : t.state;
    const look = word ? lookOf("run", word) : { glyph: "·", tone: "faint" };
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
            glyph={<Glyph kind="run" state={quiet ? "idle" : word} />}
            name={t.title}
            sub={t.kind === "run" && headRun ? runLine(headRun) : taskLine(t)}
            word={word}
            tone={quiet ? "faint" : look.tone}
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
              const st = paneStateOf(p);
              return (
                <Row
                  key={p.id}
                  className="pane-row"
                  nested
                  glyph={<Glyph kind="pane" state={st} />}
                  name={paneLabel(p)}
                  word={st}
                  tone={lookOf("pane", st).tone}
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
                  const st = r ? stateOf(r) : undefined;
                  return (
                    <Row
                      key={c.key}
                      nested
                      className={c.kind === "step" ? "pending-step" : ""}
                      glyph={<Glyph kind="run" state={st ?? "idle"} />}
                      name={c.title}
                      sub={
                        r
                          ? [c.step ? `step ${c.step.at} of ${c.step.of}` : undefined, r.stage, r.host]
                              .filter(Boolean)
                              .join(" · ")
                          : c.waitsFor && c.waitsFor.length > 0
                            ? `not started · waits for ${c.waitsFor.join(", ")}`
                            : "not started · can start"
                      }
                      word={st ?? "pending"}
                      tone={st ? lookOf("run", st).tone : "faint"}
                      current={r !== undefined && r.runId === current}
                      title={c.title}
                      onClick={() => {
                        if (r) onRun(r, r.terminalAsk);
                        else if (c.systemRunId)
                          window.location.hash = routeHash({
                            screen: "run",
                            runId: c.systemRunId,
                            tab: "plan",
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
              <Glyph kind="run" state={needs.length > 0 ? "needs you" : "idle"} />
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
                  onClick={() => setShowFinished(!showFinished)}
                >
                  <Glyph kind="run" state="done" />
                  {showFinished ? "▾" : "▸"} Finished · {done.length}
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
            aria-current={route.screen === p.route.screen ? "page" : undefined}
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
