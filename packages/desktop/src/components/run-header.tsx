import type { ReactNode } from "react";
import type { StageProgress } from "../api.ts";
import { RUN_TABS, type Run, routeHash } from "../model.ts";
import { StageBar } from "./stage-bar.tsx";

/**
 * The top of every screen about one run (session, plan, changes, briefing): the task, the run's
 * id, the four screens as links with the shown one marked, the screen's own actions, and the
 * stages in one line.
 */
export function RunHeader<S extends Pick<StageProgress, "id" | "state">>({
  runId,
  run,
  screen,
  task,
  stages,
  stageTitle,
  stagesTestId,
  actions,
  children,
}: {
  readonly runId: string;
  /** The run from the state; none while the state has not come, or for a run it no longer lists. */
  readonly run: Run | undefined;
  readonly screen: (typeof RUN_TABS)[number]["screen"];
  /** The task, when the screen knows it from elsewhere (the plan's board). */
  readonly task?: string | undefined;
  /** The stages to show instead of the run's (the plan's, with who worked on each). */
  readonly stages?: readonly S[] | undefined;
  stageTitle?: ((stage: S) => string) | undefined;
  readonly stagesTestId?: string | undefined;
  /** The screen's own buttons, at the end of the first line. */
  readonly actions?: ReactNode;
  /** Under the first line: the session's chips. */
  readonly children?: ReactNode;
}) {
  const title = task ?? run?.task ?? runId;
  return (
    <header className="head run-header">
      <div className="line">
        <h1 className="clip" title={title}>
          {title}
        </h1>
        <span className="id mono faint">{runId}</span>
        <span className="spacer" />
        {actions}
      </div>
      <nav className="run-tabs" aria-label="screens of this run">
        {RUN_TABS.map((t) => (
          <a
            key={t.screen}
            href={routeHash({ screen: t.screen, runId })}
            aria-current={t.screen === screen ? "page" : undefined}
          >
            {t.label}
          </a>
        ))}
      </nav>
      {children}
      {stages ? (
        <StageBar stages={stages} titleOf={stageTitle} testId={stagesTestId} />
      ) : run ? (
        <StageBar stages={run.stages} testId={stagesTestId} />
      ) : null}
    </header>
  );
}
