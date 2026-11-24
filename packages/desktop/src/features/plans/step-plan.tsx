/**
 * A step's plan, read-only, on its Overview (there is no Plan tab): where the run stands and what is left. The stages
 * in one line, the plan's steps on the left with their live state, one step on the right with
 * its file, tests, exemplar and rules, what waits for a person at the top, what comes next and
 * the artifacts below, the last events at the bottom. Everything comes from `GET /runs/:id/board`.
 */

import { useState } from "react";
import type { PlanBoardView } from "../../shared/api/api.ts";
import { Glyph } from "../../shared/components/glyph.tsx";
import { StageBar } from "../../shared/components/stage-bar.tsx";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { clock, duration, lintSummary, plural } from "../../shared/model/format.ts";
import type { Run } from "../../shared/model/runs.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyRow, ListDetail, ListRow, ListSection } from "../../ui/list-detail.tsx";
import { QuickAnswer } from "../inbox/answer.tsx";
import { ActivityList } from "../runs/activity-list.tsx";
import { problemsAt } from "../runs/model.ts";
import { FieldProblems, ProblemList } from "./doc-editor.tsx";
import { FromPlanButton } from "./from-plan-button.tsx";
import { PlanChanges } from "./plan-changes.tsx";

const or = (items: readonly string[]): string => (items.length > 0 ? items.join(", ") : "—");

export function StepPlan({
  run,
  runId,
  onOpenPane,
  onOpenRun,
  asks = true,
}: {
  /** Show what waits for the person here too; the Overview shows it once, above the plan. */
  readonly asks?: boolean;
  /** The run from the state; the board is read for a run the state no longer lists too. */
  readonly run: Run | undefined;
  readonly runId: string;
  /** Shows a pane in Terminals (the step's worker). */
  onOpenPane(paneId: string, runId: string): void;
  /** The run's Terminal tab, with the keyboard taken when asked. */
  onOpenRun(runId: string, attach?: boolean): void;
}) {
  const { client } = useDaemon("client");
  const repo = run?.repo;
  const {
    data: board,
    error,
    reload: load,
  } = usePolled(`plan:${repo ?? ""}:${runId}`, () => client.board(runId, repo), 2000);
  // The plan as a document: its lint, and whether a person may still change it.
  const planned = usePolled(`run-plan:${repo ?? ""}:${runId}`, () => client.runPlan(runId, repo), 3000);
  const [chosen, setChosen] = useState<string>();
  const steps = board?.plan?.steps ?? [];
  const step = steps.find((s) => s.id === chosen) ?? steps.find((s) => s.state === "in-progress") ?? steps[0];
  const waiting = board?.waiting[0];
  if (!board) return <div className="empty">{error ?? `reading the plan of ${runId}…`}</div>;
  const planStep = planned.data?.plan?.steps.find((s) => s.id === step?.id);
  const problems = planned.data?.lint.problems ?? [];
  const facts: [string, string, string][] = step
    ? [
        ["file", "path", `${step.action} ${step.path}`],
        ["tests first", "testsFirst", or(step.testsFirst)],
        ["exemplar", "exemplar", planStep?.patternSource?.exemplar ?? step.exemplar ?? "—"],
        ["rules", "rules", or(step.rules)],
        ["after", "dependsOn", or(step.dependsOn)],
      ]
    : [];
  // The planner writes the plan; a person reads it here and asks for changes on its approval card.
  const errors = problems.filter((p) => p.severity === "error");
  const bar = planned.data ? (
    <div className="lint-bar" data-testid="plan-lint-bar">
      <span className={errors.length > 0 ? "red" : problems.length > 0 ? "amber" : "green"}>
        lint: {lintSummary(planned.data.lint)}
      </span>
      <span className="faint">
        {" "}
        · the planner writes this plan; ask it for changes on the plan's approval card
      </span>
      <span className="spacer" />
      {/* A top run's plan can live in the Backlog, not run yet (round 17). */}
      {board.plan && !run?.parent ? <FromPlanButton runId={runId} repo={repo} /> : null}
    </div>
  ) : planned.error ? (
    // A plan file that does not fit its format: the daemon says where.
    <div className="banner" data-testid="plan-unreadable">
      The plan cannot be read: {planned.error}
    </div>
  ) : null;
  return (
    <div className="plan-view">
      {bar}
      <PlanChanges changes={planned.data?.changes} previousAt={planned.data?.previous?.at} />
      <ListDetail
        className="plan"
        testId="plan"
        top={
          <>
            <span className="faint">Stages</span>
            <StageBar stages={board.stages} variant="strip" titleOf={stageTitle} testId="plan-stages" />
          </>
        }
        listLabel="steps of the plan"
        list={
          <>
            <ListSection>
              steps · {board.plan ? `${board.plan.done}/${board.plan.steps.length}` : "no plan yet"}
            </ListSection>
            {steps.map((s, i) => (
              <ListRow
                key={s.id}
                className="step"
                selected={step?.id === s.id}
                onSelect={() => setChosen(s.id)}
                glyph={<Glyph kind="step" state={s.state} />}
                title={`${i + 1} ${s.intent}`}
                sub={`${s.path}${s.evidence && s.state === "done" ? ` · ${s.evidence.split(": ")[1] ?? s.evidence}` : ""}${
                  problemsAt(problems, s.id).length > 0
                    ? ` · ⚠ ${plural(problemsAt(problems, s.id).length, "problem")}`
                    : ""
                }`}
                trailing={<span className="dim">{s.worker?.name ?? ""}</span>}
              />
            ))}
            {board.plan === undefined ? (
              <EmptyRow>The plan stage writes plan.json; the steps appear here as it does.</EmptyRow>
            ) : null}
            <span className="spacer" />
            {asks && board.waiting.length > 0 ? (
              <>
                <ListSection>waits for you · {board.waiting.length}</ListSection>
                {board.waiting.map((q) => (
                  <ListRow
                    key={q.id}
                    className="step"
                    glyph={<Glyph kind="step" state="waiting" />}
                    title={
                      <span className="clamp" title={q.prompt}>
                        {q.prompt}
                      </span>
                    }
                    trailing={
                      <span className="dim">{duration(Date.now() - new Date(q.askedAt).getTime())}</span>
                    }
                  />
                ))}
              </>
            ) : null}
          </>
        }
      >
        {error ? <div className="banner">{error}</div> : null}
        <ProblemList problems={problems.filter((p) => p.step === undefined)} testId="plan-problems" />
        {asks && waiting ? (
          <div className="ask" data-testid="plan-ask">
            <span className="clamp" title={waiting.prompt}>
              <span className="amber">?</span> {waiting.agent ?? waiting.source} asks: <b>{waiting.prompt}</b>{" "}
              <span className="dim">· {duration(Date.now() - new Date(waiting.askedAt).getTime())}</span>
            </span>
            <span className="spacer" />
            {waiting.source === "permission" ? (
              <Button variant="primary" onClick={() => onOpenRun(runId, true)}>
                Answer in the pane
              </Button>
            ) : (
              <QuickAnswer question={waiting} repo={run?.repo} onDone={() => void load()} />
            )}
          </div>
        ) : null}
        {step ? (
          <>
            <h4>
              {steps.indexOf(step) + 1} · {step.intent} <span className="dim">in {step.path}</span>
            </h4>
            <div className="dim">
              {step.worker
                ? `${step.worker.name}${step.worker.paneId ? ` · ${step.worker.paneId}` : ""} · `
                : ""}
              {step.state}
              {step.evidence ? ` · ${step.evidence}` : ""}
            </div>
            <dl className="facts">
              {facts.map(([name, field, value]) => (
                <div className="row" key={name}>
                  <dt className="dim">{name}</dt>
                  <dd className="mono">
                    {value}
                    <FieldProblems problems={problemsAt(problems, step.id, field)} />
                  </dd>
                </div>
              ))}
            </dl>
            <ProblemList
              problems={problemsAt(problems, step.id).filter(
                (p) => !facts.some(([, field]) => p.field?.endsWith(field)),
              )}
            />
            {step.worker?.paneId ? (
              <div className="actions">
                <Button variant="primary" onClick={() => onOpenPane(step.worker?.paneId as string, runId)}>
                  Show the pane
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <h4 className="dim">
            {board.stage} · {board.status}
          </h4>
        )}
        <div className="cols">
          <div>
            <ListSection>what comes next</ListSection>
            <div className="text">
              {board.next.length > 0
                ? board.next
                    .map((n) => `${n.id}${n.owners.length > 0 ? ` (${n.owners.join(", ")})` : ""}`)
                    .join(" · ")
                : board.status === "done"
                  ? "nothing: the run is done"
                  : "this is the last stage"}
            </div>
            {board.gates.length > 0 ? (
              <div className="text">
                gates:{" "}
                {board.gates.map((g) => (
                  <span key={`${g.gate}-${g.at}`} className={g.passed ? "green" : "red"}>
                    {g.gate} {g.passed ? "✓" : "✕"}{" "}
                  </span>
                ))}
              </div>
            ) : null}
            {board.resumes.length > 0 ? (
              <>
                <ListSection>resumed</ListSection>
                <ul className="text resumes" aria-label="resumes">
                  {board.resumes.map((r) => (
                    <li key={r.at}>
                      <span className="dim mono">{clock(r.at)}</span> at {r.to}
                      {r.to === r.from ? "" : ` (escalated at ${r.from})`} by {r.by}
                      {r.note ? <span className="amber">: {r.note}</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
          {board.workers.length > 0 ? (
            <div>
              <ListSection>workers</ListSection>
              <div className="text">
                {board.workers.map((w) => (
                  <div key={w.name}>
                    <Button variant="ghost" className="mono" onClick={() => onOpenPane(w.paneId, runId)}>
                      {w.name}
                    </Button>{" "}
                    <span className="dim">
                      {w.stage} · {w.paneId} ·{" "}
                      {w.result ? `${w.result.status}: ${w.result.summary}` : (w.state ?? "")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <span className="spacer" />
        <ActivityList entries={board.timeline.slice(-8)} variant="list" />
      </ListDetail>
    </div>
  );
}

const stageTitle = (s: PlanBoardView["stages"][number]): string =>
  [
    s.owners.length > 0 ? `owner: ${s.owners.join(", ")}` : "",
    s.workedBy.length > 0 ? `worked by ${s.workedBy.join(", ")}` : "",
    s.startedAt ? `from ${clock(s.startedAt)}` : "",
    s.endedAt ? `to ${clock(s.endedAt)}` : "",
    s.verdict ? s.verdict : "",
  ]
    .filter((x) => x !== "")
    .join(" · ");
