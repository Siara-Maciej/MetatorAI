/**
 * The sidebar: the whole dashboard in one column. On top what needs the person (each row opens
 * its decision), then the runs of each repository with their panes under them, then the places
 * that are not a run, and the one button that starts a run. Every row is the same: the state's
 * glyph, a name, the state's word at the end, and one dim line under the name.
 */
import type { ReactNode } from "react";
import { useState } from "react";
import { useDaemon } from "../daemon.tsx";
import {
  isFinished,
  lookOf,
  type NeedRow,
  openRuns,
  paneLabel,
  paneStateOf,
  panesOfRun,
  plural,
  type Route,
  type Run,
  rollUp,
  routeHash,
  runLine,
  runWithPanes,
  sameRepo,
  seenKey,
  sidebarRuns,
} from "../model.ts";
import { Glyph } from "./glyph.tsx";
import { moveInList } from "./list-keys.ts";

/** The places that are not a run, in the order of the sidebar's bottom. */
const PLACES: readonly { readonly route: Route; readonly label: string; readonly glyph: string }[] = [
  { route: { screen: "grid" }, label: "Terminals", glyph: "▦" },
  { route: { screen: "backlog" }, label: "Backlog", glyph: "☷" },
  { route: { screen: "mrs" }, label: "Reviews", glyph: "⇄" },
  { route: { screen: "overview", tab: "daemon" }, label: "Overview", glyph: "◎" },
  { route: { screen: "settings" }, label: "Settings", glyph: "⚙" },
];

/** One row of the sidebar: glyph, name, the state's word, one dim line. */
function Row({
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
  picked,
  onNeed,
  onRun,
  onInbox,
  onNew,
  onForm,
}: {
  readonly route: Route;
  /** Everything that needs the person (model.ts `needsQueue`). */
  readonly needs: readonly NeedRow[];
  /** The row the Inbox shows, when the Inbox is the screen. */
  readonly picked: string | undefined;
  onNeed(row: NeedRow): void;
  onRun(run: Run, pane?: string): void;
  onInbox(): void;
  /** Opens the agent that starts a run: the person describes it. */
  onNew(): void;
  /** The form: workflow, autonomy, host and worktree chosen by hand. */
  onForm(): void;
}) {
  const { runs, repos, panesOf, down, unreadable, seen } = useDaemon();
  const [showFinished, setShowFinished] = useState(false);
  const current = route.screen === "run" ? route.runId : undefined;
  const stateOf = (r: Run) =>
    runWithPanes(
      r,
      panesOfRun(panesOf(r.repo), r.runId).map((p) => paneStateOf(p)),
      seen[seenKey(r)],
    );
  const runRows = (r: Run, nested: boolean, step?: string) => {
    const state = stateOf(r);
    // A run with more than its conductor shows its panes under it (R4): who works, in what state.
    const own = isFinished(r) ? [] : panesOfRun(panesOf(r.repo), r.runId);
    return (
      <div key={`${r.repo ?? ""}/${r.runId}`}>
        <Row
          glyph={<Glyph kind="run" state={state} />}
          name={r.task}
          sub={runLine(r, step)}
          word={state}
          tone={lookOf("run", state).tone}
          current={r.runId === current}
          nested={nested}
          title={r.task}
          onClick={() => onRun(r, r.terminalAsk)}
        />
        {own.length < 2
          ? null
          : own.map((p) => {
              const s = paneStateOf(p);
              return (
                <Row
                  key={p.id}
                  className="pane-row"
                  nested
                  glyph={<Glyph kind="pane" state={s} />}
                  name={paneLabel(p)}
                  word={s}
                  tone={lookOf("pane", s).tone}
                  current={r.runId === current && route.screen === "run" && route.pane === p.id}
                  title={`${p.id} · ${p.state?.reason ?? ""}`}
                  onClick={() => onRun(r, p.id)}
                />
              );
            })}
      </div>
    );
  };
  const finished = runs.filter(isFinished);
  return (
    <aside className="sessions" aria-label="runs" onKeyDown={(e) => moveInList(e, ".row")}>
      <div className="list">
        {down ? (
          <div className="section">No daemon: nothing to list</div>
        ) : (
          <>
            <div className="needs">
              <button type="button" className="section" data-testid="needs-count" onClick={onInbox}>
                <Glyph kind="run" state={needs.length > 0 ? "needs you" : "idle"} />
                Needs you · {needs.length}
              </button>
              {needs.map((n) => (
                <Row
                  key={n.key}
                  className="item"
                  glyph={<Glyph kind="need" state={n.kind} />}
                  name={n.title}
                  sub={n.sub}
                  word={n.kind}
                  tone={lookOf("need", n.kind).tone}
                  current={route.screen === "inbox" && picked === n.key}
                  title={n.hint}
                  data-testid={
                    n.kind === "terminal"
                      ? `terminal-ask-${n.runId}`
                      : n.kind === "escalated"
                        ? `escalated-${n.runId}`
                        : undefined
                  }
                  onClick={() => onNeed(n)}
                />
              ))}
              {needs.length === 0 ? <div className="quiet">Nothing needs you.</div> : null}
            </div>
            {(repos.length > 0 ? repos.map((x) => x.name) : [""]).map((repo) => {
              const here = openRuns(runs.filter((r) => sameRepo(r.repo, repo)));
              return (
                <div key={repo || "."} className="repo">
                  <div className="section">
                    <Glyph kind="run" state={rollUp(here.map(stateOf))} />
                    {repo || "Runs"} · {here.length}
                  </div>
                  {sidebarRuns(here).map((x) => runRows(x.run, x.nested, x.step))}
                  {here.length === 0 ? <div className="quiet">No run is open.</div> : null}
                </div>
              );
            })}
            {finished.length > 0 ? (
              <div className="repo">
                <button
                  type="button"
                  className="section"
                  aria-expanded={showFinished}
                  onClick={() => setShowFinished(!showFinished)}
                >
                  <Glyph kind="run" state={rollUp(finished.map(stateOf))} />
                  {showFinished ? "▾" : "▸"} Finished · {finished.length}
                </button>
                {showFinished ? finished.map((r) => runRows(r, false)) : null}
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
