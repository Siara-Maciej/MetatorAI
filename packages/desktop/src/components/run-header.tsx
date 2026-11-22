import type { ReactNode } from "react";
import { type FirstLevel, lookOf, type Run, type RunTab, routeHash, tabsOf } from "../model.ts";
import { Glyph } from "./glyph.tsx";
import { StageBar } from "./stage-bar.tsx";

/**
 * The top of the page about a task or a step. The first level only: the breadcrumb back to its
 * task, the name, one of the four state words with the reason when it is blocked, a progress
 * bar and the current stage; then the page's tabs. What the run is (its id, workflow, autonomy,
 * host, ports, age, every stage) is in **Details**, folded.
 */
export function RunHeader({
  runId,
  run,
  tab,
  task,
  title,
  state,
  why,
  progress,
  partOf,
  details,
}: {
  readonly runId: string;
  /** The run from the state; none while the state has not come, or for a run it no longer lists. */
  readonly run: Run | undefined;
  readonly tab: RunTab;
  /** A task's page (Overview · Changes · Activity) or a step's (with its Terminal). */
  readonly task: boolean;
  readonly title: string;
  readonly state: FirstLevel;
  /** Why it is blocked, in one line. */
  readonly why?: string | undefined;
  readonly progress: { readonly done: number; readonly of: number; readonly text: string };
  /** The task this step is part of: the breadcrumb leads back to its page. */
  readonly partOf?: { readonly title: string; readonly href: string } | undefined;
  /** Inside Details: what the run is. */
  readonly details?: ReactNode;
}) {
  // A run made to plan only reads "plan ready" (round 17): done, with its plan approved.
  const planned = run?.status === "planned";
  const look = planned ? lookOf("run", "plan ready") : lookOf("first", state);
  const current = run?.stages.find(
    (s) => s.state === "current" || s.state === "waiting" || s.state === "stopped",
  );
  const pct = progress.of > 0 ? Math.round((progress.done / progress.of) * 100) : 0;
  return (
    <header className="head run-header">
      {partOf ? (
        <nav className="breadcrumb" aria-label="where this step is" data-testid="breadcrumb">
          <a href={partOf.href}>{partOf.title}</a> <span className="faint">›</span>{" "}
          <span className="here">{title}</span>
        </nav>
      ) : null}
      <div className="line">
        <h1 className="clip" title={title}>
          {title}
        </h1>
        <span className={`state-word ${look.tone ?? ""}`} data-testid="page-state">
          {planned ? (
            <>
              <Glyph kind="run" state="plan ready" /> plan ready
            </>
          ) : (
            <>
              <Glyph kind="first" state={state} /> {state}
            </>
          )}
        </span>
      </div>
      <div className="head-progress">
        <div
          className="progress"
          role="progressbar"
          aria-label={progress.text}
          aria-valuemin={0}
          aria-valuemax={progress.of}
          aria-valuenow={progress.done}
        >
          <span className={`fill ${look.tone ?? ""}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="dim" data-testid="page-progress">
          {progress.text}
          {current && run && run.status !== "done" && run.status !== "aborted" ? ` · now ${current.id}` : ""}
        </span>
      </div>
      {why ? (
        <div className={`why ${look.tone ?? ""}`} data-testid="page-why">
          {why}
        </div>
      ) : null}
      <nav className="run-tabs" aria-label="tabs of this run">
        {tabsOf(task).map((t) => (
          <a
            key={t.tab}
            href={routeHash({ screen: "run", runId, tab: t.tab })}
            aria-current={t.tab === tab ? "page" : undefined}
            title={`key ${t.key}`}
          >
            {t.label}
          </a>
        ))}
      </nav>
      <details className="head-details" data-testid="run-details">
        <summary>Details</summary>
        <div className="line">
          <span className="id mono faint">{runId}</span>
        </div>
        {details}
        {run ? <StageBar stages={run.stages} /> : null}
      </details>
    </header>
  );
}
