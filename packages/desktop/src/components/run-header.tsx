import type { ReactNode } from "react";
import { RUN_TABS, type Run, type RunTab, routeHash } from "../model.ts";
import { StageBar } from "./stage-bar.tsx";

/**
 * The top of the page about one run: the task, the run's id, the page's tabs as links with the
 * shown one marked, and the stages in one line.
 */
export function RunHeader({
  runId,
  run,
  tab,
  showStages = true,
  children,
}: {
  readonly runId: string;
  /** The run from the state; none while the state has not come, or for a run it no longer lists. */
  readonly run: Run | undefined;
  readonly tab: RunTab;
  /** The plan shows the stages itself, with who worked on each. */
  readonly showStages?: boolean;
  /** Under the tabs: what the run is (workflow, host, ports). */
  readonly children?: ReactNode;
}) {
  const title = run?.task ?? runId;
  return (
    <header className="head run-header">
      <div className="line">
        <h1 className="clip" title={title}>
          {title}
        </h1>
        <span className="id mono faint">{runId}</span>
      </div>
      <nav className="run-tabs" aria-label="tabs of this run">
        {RUN_TABS.map((t) => (
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
      {children}
      {showStages && run ? <StageBar stages={run.stages} /> : null}
    </header>
  );
}
