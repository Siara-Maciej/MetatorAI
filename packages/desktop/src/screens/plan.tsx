/**
 * The plan (S2, design/13 §2, mockup "Plan"): where the run stands and what is left. The stages
 * in one line, the plan's steps on the left with their live state, one step on the right with
 * its file, tests, exemplar and rules, what waits for a person at the top, what comes next and
 * the artifacts below, the last events at the bottom. Everything comes from `GET /runs/:id/board`.
 */
import { useState } from "react";
import type { BoardStep, PlanBoardView } from "../api.ts";
import { QuickAnswer } from "../components/answer.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { clock, duration, stageGlyph } from "../model.ts";

const STEP_GLYPH: Record<BoardStep["state"], string> = {
  done: "✓",
  "in-progress": "⋮",
  blocked: "!",
  todo: "○",
};

export function PlanScreen({
  runId,
  onOpenPane,
  onOpenSession,
}: {
  readonly runId: string;
  /** Shows a pane on the workbench (the step's worker). */
  onOpenPane(paneId: string, runId: string): void;
  onOpenSession(runId: string, attach?: boolean): void;
}) {
  const { client, runs } = useDaemon();
  const run = runs.find((r) => r.runId === runId);
  const {
    data: board,
    error,
    reload: load,
  } = usePolled(`plan:${run?.repo ?? ""}:${runId}`, () => client.board(runId, run?.repo), 2000);
  const [chosen, setChosen] = useState<string>();
  const steps = board?.plan?.steps ?? [];
  const step = steps.find((s) => s.id === chosen) ?? steps.find((s) => s.state === "in-progress") ?? steps[0];
  const waiting = board?.waiting[0];
  if (!board)
    return (
      <div className="plan">
        <div className="empty">{error ?? `reading the plan of ${runId}…`}</div>
      </div>
    );
  return (
    <div className="plan" data-testid="plan">
      <div className="top">
        <span className="dim clip" title={board.task}>
          ‹ {board.task}
        </span>
        <b>Plan</b>
        <span className="spacer" />
        <span className="strip" data-testid="plan-stages">
          {board.stages.map((s, i) => (
            <span key={s.id} className={`stage ${s.state}`} title={stageTitle(s)}>
              {i > 0 ? <span className="dim"> · </span> : null}
              {s.id} {stageGlyph(s)}
            </span>
          ))}
        </span>
      </div>
      <div className="body">
        <aside className="steps">
          <div className="sec">
            steps · {board.plan ? `${board.plan.done}/${board.plan.steps.length}` : "no plan yet"}
          </div>
          {steps.map((s, i) => (
            <button
              type="button"
              key={s.id}
              className={`step${step?.id === s.id ? " sel" : ""}`}
              aria-current={step?.id === s.id ? "true" : undefined}
              onClick={() => setChosen(s.id)}
            >
              <span className={`g ${s.state}`}>{STEP_GLYPH[s.state]}</span>
              <span className="n">
                {i + 1} {s.intent}
                <span className="sub dim">
                  {s.path}
                  {s.evidence && s.state === "done" ? ` · ${s.evidence.split(": ")[1] ?? s.evidence}` : ""}
                </span>
              </span>
              <span className="dim">{s.worker?.name ?? ""}</span>
            </button>
          ))}
          {board.plan === undefined ? (
            <div className="dim" style={{ padding: "6px 20px", fontSize: 12 }}>
              The plan stage writes plan.json; the steps appear here as it does.
            </div>
          ) : null}
          <span className="spacer" />
          {board.waiting.length > 0 ? (
            <>
              <div className="sec">waits for you · {board.waiting.length}</div>
              {board.waiting.map((q) => (
                <div key={q.id} className="step">
                  <span className="g waiting">?</span>
                  <span className="n clamp" title={q.prompt}>
                    {q.prompt}
                  </span>
                  <span className="dim">{duration(Date.now() - new Date(q.askedAt).getTime())}</span>
                </div>
              ))}
            </>
          ) : null}
        </aside>
        <main className="detail">
          {error ? <div className="banner">{error}</div> : null}
          {waiting ? (
            <div className="ask" data-testid="plan-ask">
              <span className="clamp" title={waiting.prompt}>
                <span className="amber">?</span> {waiting.agent ?? waiting.source} asks:{" "}
                <b>{waiting.prompt}</b>{" "}
                <span className="dim">· {duration(Date.now() - new Date(waiting.askedAt).getTime())}</span>
              </span>
              <span className="spacer" />
              {waiting.source === "permission" ? (
                <button type="button" className="primary" onClick={() => onOpenSession(runId, true)}>
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
              <div className="facts">
                <div className="row">
                  <span className="dim">file</span>
                  <span className="mono">
                    {step.action} {step.path}
                  </span>
                </div>
                <div className="row">
                  <span className="dim">tests first</span>
                  <span className="mono">
                    {step.testsFirst.length > 0 ? step.testsFirst.join(", ") : "—"}
                  </span>
                </div>
                <div className="row">
                  <span className="dim">exemplar</span>
                  <span className="mono">{step.exemplar ?? "—"}</span>
                </div>
                <div className="row">
                  <span className="dim">rules</span>
                  <span className="mono">{step.rules.length > 0 ? step.rules.join(", ") : "—"}</span>
                </div>
                <div className="row">
                  <span className="dim">after</span>
                  <span className="mono">{step.dependsOn.length > 0 ? step.dependsOn.join(", ") : "—"}</span>
                </div>
              </div>
              <div className="actions">
                {step.worker?.paneId ? (
                  <button
                    type="button"
                    className="go"
                    onClick={() => onOpenPane(step.worker?.paneId as string, runId)}
                  >
                    Show the pane
                  </button>
                ) : null}
                <button type="button" onClick={() => onOpenSession(runId)}>
                  The session
                </button>
              </div>
            </>
          ) : (
            <h2 className="dim">
              {board.stage} · {board.status}
            </h2>
          )}
          <div className="cols">
            <div>
              <div className="sec">what comes next</div>
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
              <div className="sec">artifacts</div>
              <div className="text mono">
                {board.artifacts.map((a) => (
                  <span
                    key={a.name}
                    className={a.present ? "" : "dim"}
                    title={a.stage ? `from ${a.stage}` : undefined}
                  >
                    {a.present ? "✓" : "○"} {a.name}{" "}
                  </span>
                ))}
              </div>
            </div>
            {board.resumes && board.resumes.length > 0 ? (
              <div>
                <div className="sec">resumed</div>
                <ul className="text resumes" aria-label="resumes">
                  {board.resumes.map((r) => (
                    <li key={r.at}>
                      <span className="dim mono">{clock(r.at)}</span> at {r.to}
                      {r.to === r.from ? "" : ` (escalated at ${r.from})`} by {r.by}
                      {r.note ? <span className="amber">: {r.note}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {board.workers.length > 0 ? (
              <div>
                <div className="sec">workers</div>
                <div className="text">
                  {board.workers.map((w) => (
                    <div key={w.name}>
                      <button
                        type="button"
                        className="ghost mono"
                        onClick={() => onOpenPane(w.paneId, runId)}
                      >
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
          <ul className="timeline" aria-label="timeline">
            {board.timeline.slice(-8).map((e, i) => (
              <li key={`${e.at}-${String(i)}`} className={e.type === "question" ? "amber" : undefined}>
                <span className="dim mono">{clock(e.at)}</span> {e.agent ? `${e.agent} ` : ""}
                {e.text}
              </li>
            ))}
          </ul>
        </main>
      </div>
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
