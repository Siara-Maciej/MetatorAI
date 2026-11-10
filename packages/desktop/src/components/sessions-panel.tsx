/**
 * The sessions panel (spec §5.2, screen K): App mode lists runs per repository, Run mode shows
 * feature groups as frames with their steps; both in the panel's order.
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
  onGrid,
}: {
  readonly current?: string | undefined;
  onOpen(runId: string, pane?: string): void;
  onNew(): void;
  onGrid(group?: string): void;
}) {
  const { runs, repos, panes } = useDaemon();
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
    const own = panesOfRun(panes, r.runId);
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
        onClick={() => onOpen(r.runId)}
      >
        <Dot attention={r.attention} human={r.driver === "human"} />
        <span>
          <div className="title">
            {label ? <span className="chip blue">{label}</span> : null} {r.task}
          </div>
          <div className="sub">
            {r.stage} · {r.host ?? "no host"} · {attentionLabel(r.attention)} · {duration(r.elapsedMs)}
          </div>
        </span>
        <span className="dim">{r.questions.length > 0 ? `?${r.questions.length}` : ""}</span>
      </button>
      {paneRows(r)}
    </div>
  );
  const active = (list: readonly Run[]) => list.filter((r) => r.status === "active");
  return (
    <aside className="sessions" aria-label="sessions">
      <div className="mode" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "app"} onClick={() => setMode("app")}>
          App
        </button>
        <button type="button" role="tab" aria-selected={mode === "run"} onClick={() => setMode("run")}>
          Run
        </button>
      </div>
      <div className="list">
        {mode === "app" ? (
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
                    <span>feature · {parent?.task ?? g.parent}</span>
                    <span>
                      {g.done} / {g.steps.length}
                    </span>
                  </div>
                  {g.steps.map((s, i) => row(s, `${i + 1}${i > 0 ? " · then" : ""}`))}
                </div>
              );
            })}
            <div className="section">standalone · {active(groups.standalone).length}</div>
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
        <button type="button" className="primary" onClick={onNew}>
          + New session
        </button>
        <button
          type="button"
          title="Open the selected group as a terminal grid"
          onClick={() => onGrid(groups.groups[0]?.parent)}
        >
          ▦
        </button>
      </div>
    </aside>
  );
}
