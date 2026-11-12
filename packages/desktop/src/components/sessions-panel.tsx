/**
 * The sessions panel (spec §5.2, screen K): "By repository" lists runs per repository, "By task"
 * shows a task split into steps as a frame with its steps; both in the panel's order.
 */
import { useEffect, useState } from "react";
import { useDaemon } from "../daemon.tsx";
import {
  byPanelOrder,
  duration,
  groupByFeature,
  paneLabel,
  panesOfRun,
  type Run,
  stateTone,
  stepLabel,
} from "../model.ts";
import { attentionLabel, Chip, Dot } from "./chips.tsx";

type Mode = "app" | "run";

const readMode = (): Mode => {
  try {
    return localStorage.getItem("metator.panel") === "run" ? "run" : "app";
  } catch {
    return "app";
  }
};

export function SessionsPanel({
  current,
  onOpen,
  onNew,
  onAdvanced,
}: {
  readonly current?: string | undefined;
  onOpen(runId: string, pane?: string): void;
  /** Opens a pane with the agent as the entry point (design/14 §2): the conversation starts the task. */
  onNew(): void;
  /** The form: workflow, autonomy, host and worktree chosen by hand. */
  onAdvanced(): void;
}) {
  const { runs, repos, panes, down } = useDaemon();
  const [mode, setMode] = useState<Mode>(readMode);
  useEffect(() => {
    try {
      localStorage.setItem("metator.panel", mode);
    } catch {
      /* nothing kept */
    }
  }, [mode]);
  const ordered = byPanelOrder(runs);
  const groups = groupByFeature<Run>(ordered);
  const finished = ordered.filter((r) => r.status !== "active");
  const [showFinished, setShowFinished] = useState(false);
  // A run with more than its conductor shows its panes under it (R4): who works, in what state.
  const paneRows = (r: Run) => {
    const own = panesOfRun(
      panes.filter((p) => (p.repo ?? "") === (r.repo ?? "")),
      r.runId,
    );
    if (own.length < 2) return null;
    return own.map((p) => (
      <button
        type="button"
        key={p.id}
        className="row pane-row"
        onClick={() => onOpen(r.runId, p.id)}
        title={p.state?.reason ?? p.id}
      >
        <span />
        <span className="sub">
          {paneLabel(p)} <span className="dim">· {p.id}</span>
        </span>
        <Chip tone={stateTone(p.state?.state)}>{p.state?.state ?? (p.live?.alive ? "live" : "off")}</Chip>
      </button>
    ));
  };
  const row = (r: Run, label?: string) => (
    <div key={r.runId}>
      <button
        type="button"
        className="row"
        aria-current={r.runId === current ? "true" : undefined}
        onClick={() => onOpen(r.runId, r.terminalAsk)}
        title={r.task}
      >
        <Dot attention={r.attention} human={r.driver === "human"} />
        <span className="text">
          <div className="title">
            {label ? <span className="chip blue">{label}</span> : null} {r.task}
          </div>
          <div className="sub">
            {r.stage} · {r.host ?? "no host"} ·{" "}
            {r.terminalAsk ? "asks in its terminal" : attentionLabel(r.attention)} · {duration(r.elapsedMs)}
          </div>
        </span>
        <span className="dim">
          {r.questions.length > 0 ? `?${r.questions.length}` : r.terminalAsk ? "?" : ""}
        </span>
      </button>
      {paneRows(r)}
    </div>
  );
  const active = (list: readonly Run[]) => list.filter((r) => r.status === "active");
  return (
    <aside className="sessions" aria-label="sessions">
      <div className="mode" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "app"}
          title="The active sessions of each repository"
          onClick={() => setMode("app")}
        >
          By repository
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "run"}
          title="The steps of a task that was split, under their task"
          onClick={() => setMode("run")}
        >
          By task
        </button>
      </div>
      <div className="list">
        {down ? (
          <div className="section">no daemon: nothing to list</div>
        ) : mode === "app" ? (
          (repos.length > 0 ? repos.map((x) => x.name) : [""]).map((repo) => {
            const here = active(ordered.filter((r) => (r.repo ?? "") === repo));
            return (
              <div key={repo || "."}>
                <div className="section">
                  {repo || "this repository"} · {here.length}
                </div>
                {here.map((r) => row(r, stepLabel(r, groups.groups)))}
              </div>
            );
          })
        ) : (
          <>
            {groups.groups.map((g) => {
              const parent = runs.find((r) => r.runId === g.parent);
              return (
                <div className="group" key={g.parent}>
                  <div className="head">
                    <span className="clip" title={parent?.task ?? g.parent}>
                      task · {parent?.task ?? g.parent}
                    </span>
                    <span>
                      {g.done} / {g.steps.length}
                    </span>
                  </div>
                  {g.steps.map((s, i) => row(s, `${i + 1}${i > 0 ? " · then" : ""}`))}
                </div>
              );
            })}
            <div className="section">not split · {active(groups.standalone).length}</div>
            {active(groups.standalone).map((r) => row(r))}
          </>
        )}
        {finished.length > 0 ? (
          <>
            <button type="button" className="row" onClick={() => setShowFinished(!showFinished)}>
              <span />
              <span className="sub">
                {showFinished ? "▾" : "▸"} {finished.length} finished
              </span>
              <span />
            </button>
            {showFinished ? finished.map((r) => row(r)) : null}
          </>
        ) : null}
      </div>
      <div className="footer">
        <button
          type="button"
          className="primary"
          title="Talk to the agent; it starts the run"
          disabled={down}
          onClick={onNew}
        >
          + New session
        </button>
        <button
          type="button"
          title="The form: workflow, autonomy, host, worktree"
          disabled={down}
          onClick={onAdvanced}
        >
          Advanced…
        </button>
      </div>
    </aside>
  );
}
