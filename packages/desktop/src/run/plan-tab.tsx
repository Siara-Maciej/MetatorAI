/**
 * The plan (S2, design/13 §2, mockup "Plan"): where the run stands and what is left. The stages
 * in one line, the plan's steps on the left with their live state, one step on the right with
 * its file, tests, exemplar and rules, what waits for a person at the top, what comes next and
 * the artifacts below, the last events at the bottom. Everything comes from `GET /runs/:id/board`.
 */
import { useState } from "react";
import type { Plan, PlanBoardView, RunPlanView } from "../api.ts";
import { ActivityList } from "../components/activity-list.tsx";
import { QuickAnswer } from "../components/answer.tsx";
import { ArtifactList } from "../components/artifact-list.tsx";
import {
  type DocSource,
  EditBar,
  FieldProblems,
  ProblemList,
  useDocEditor,
} from "../components/doc-editor.tsx";
import { Glyph } from "../components/glyph.tsx";
import { EmptyRow, ListDetail, ListRow, ListSection } from "../components/list-detail.tsx";
import { StageBar } from "../components/stage-bar.tsx";
import { SystemPlanPanel } from "../components/system-plan.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { clock, duration, plural, problemsAt, type Run, systemPlanOf } from "../model.ts";
import { planChanges } from "../plan-edit.ts";
import { PlanForm, TextEditor } from "./plan-form.tsx";

const or = (items: readonly string[]): string => (items.length > 0 ? items.join(", ") : "—");

export function PlanTab(props: {
  readonly run: Run | undefined;
  readonly runId: string;
  onOpenPane(paneId: string, runId: string): void;
  onOpenRun(runId: string, attach?: boolean): void;
}) {
  const { systemPlans, runs } = useDaemon();
  const { run } = props;
  // A system run's plan is its system plan: the steps across repositories and their child runs.
  const system = run ? systemPlanOf(systemPlans, run, runs) : undefined;
  if (system)
    return <SystemPlanPanel planId={system.plan.id} repo={system.repo} onOpenRun={props.onOpenRun} />;
  if (run && /system/.test(run.workflow))
    return <SystemPlanPanel planOfRun={run} repo={run.repo} onOpenRun={props.onOpenRun} />;
  return <RunPlanTab {...props} />;
}

function RunPlanTab({
  run,
  runId,
  onOpenPane,
  onOpenRun,
}: {
  /** The run from the state; the board is read for a run the state no longer lists too. */
  readonly run: Run | undefined;
  readonly runId: string;
  /** Shows a pane in Terminals (the step's worker). */
  onOpenPane(paneId: string, runId: string): void;
  /** The run's Terminal tab, with the keyboard taken when asked. */
  onOpenRun(runId: string, attach?: boolean): void;
}) {
  const { client } = useDaemon();
  const repo = run?.repo;
  const {
    data: board,
    error,
    reload: load,
  } = usePolled(`plan:${repo ?? ""}:${runId}`, () => client.board(runId, repo), 2000);
  // The plan as a document: its lint, and whether a person may still change it.
  const planned = usePolled(`run-plan:${repo ?? ""}:${runId}`, () => client.runPlan(runId, repo), 3000);
  const source: DocSource<RunPlanView, Plan> = {
    view: planned.data,
    reload: () => Promise.all([planned.reload(), load()]),
    docOf: (v) => v.plan,
    digestOf: (v) => v.digest,
    lintOf: (v) => v.lint,
    editable: (v) => v.editable,
    readOnlyBecause: (v) => v.readOnlyBecause,
    check: (plan) => client.lintRunPlan(runId, plan, repo),
    save: (plan, digest, by) => client.saveRunPlan(runId, { plan, digest, by }, repo),
    changes: planChanges,
  };
  const editor = useDocEditor(source);
  const [chosen, setChosen] = useState<string>();
  const steps = board?.plan?.steps ?? [];
  const step = steps.find((s) => s.id === chosen) ?? steps.find((s) => s.state === "in-progress") ?? steps[0];
  const waiting = board?.waiting[0];
  if (!board) return <div className="empty">{error ?? `reading the plan of ${runId}…`}</div>;
  const planStep = planned.data?.plan?.steps.find((s) => s.id === step?.id);
  const problems = editor.problems;
  const facts: [string, string, string][] = step
    ? [
        ["file", "path", `${step.action} ${step.path}`],
        ["tests first", "testsFirst", or(step.testsFirst)],
        ["exemplar", "exemplar", planStep?.patternSource?.exemplar ?? step.exemplar ?? "—"],
        ["rules", "rules", or(step.rules)],
        ["after", "dependsOn", or(step.dependsOn)],
      ]
    : [];
  const bar = planned.data ? (
    <EditBar editor={editor} source={source} noun="plan" testId="plan-edit-bar" />
  ) : planned.error ? (
    // A plan file that does not fit its format cannot be shown as fields: the daemon says where.
    <div className="banner" data-testid="plan-unreadable">
      The plan cannot be read: {planned.error}
    </div>
  ) : null;
  if (editor.mode !== "view" && planned.data)
    return (
      <div className="plan-editing" data-testid="plan">
        {bar}
        {editor.mode === "form" && editor.draft ? (
          <PlanForm plan={editor.draft} problems={problems} onChange={editor.setDraft} />
        ) : (
          <TextEditor
            text={editor.text}
            label="the plan as JSON"
            problems={problems}
            onChange={editor.setText}
          />
        )}
      </div>
    );
  return (
    <div className="plan-view">
      {bar}
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
            {board.waiting.length > 0 ? (
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
        {waiting ? (
          <div className="ask" data-testid="plan-ask">
            <span className="clamp" title={waiting.prompt}>
              <span className="amber">?</span> {waiting.agent ?? waiting.source} asks: <b>{waiting.prompt}</b>{" "}
              <span className="dim">· {duration(Date.now() - new Date(waiting.askedAt).getTime())}</span>
            </span>
            <span className="spacer" />
            {waiting.source === "permission" ? (
              <button type="button" className="primary" onClick={() => onOpenRun(runId, true)}>
                Answer in the pane
              </button>
            ) : (
              <QuickAnswer question={waiting} repo={run?.repo} onDone={() => void load()} />
            )}
          </div>
        ) : null}
        {step ? (
          <>
            <h2>
              {steps.indexOf(step) + 1} · {step.intent} <span className="dim">in {step.path}</span>
            </h2>
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
                <button
                  type="button"
                  className="primary"
                  onClick={() => onOpenPane(step.worker?.paneId as string, runId)}
                >
                  Show the pane
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <h2 className="dim">
            {board.stage} · {board.status}
          </h2>
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
          </div>
          <div>
            <ListSection>artifacts</ListSection>
            <ArtifactList runId={runId} repo={repo} />
          </div>
          {board.workers.length > 0 ? (
            <div>
              <ListSection>workers</ListSection>
              <div className="text">
                {board.workers.map((w) => (
                  <div key={w.name}>
                    <button type="button" className="ghost mono" onClick={() => onOpenPane(w.paneId, runId)}>
                      {w.name}
                    </button>{" "}
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
