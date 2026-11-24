/**
 * An escalated run (F1, D9): why it stopped, and the two ways on. Resume puts it back at the stage
 * it escalated from, or at an earlier one it worked, with a note for the next agent, and drives it;
 * Close ends it as aborted, with the person's reason. The card
 * is the Inbox's; the session screen of an escalated run shows the same actions in its bar.
 */
import { useState } from "react";
import { useDaemon } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { duration, type Run, resumeNotice, resumePlan, resumeStages } from "../model.ts";
import { Notice } from "./common.tsx";
import { RetryAbortedSteps } from "./retry-step.tsx";
import { StopReason } from "./stop-reason.tsx";

/** Resume and Close of an escalated run, with the reason field Close needs and what the daemon answered. */
export function EscalatedActions({
  run,
  onDone,
  children,
}: {
  readonly run: Run;
  /** The run was resumed and is driven, or it was closed. */
  onDone?: (() => void) | undefined;
  /** More buttons on the same row (the card: Briefing, Changes). */
  readonly children?: React.ReactNode;
}) {
  const { client } = useDaemon("client");
  const action = useAction();
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const [to, setTo] = useState(run.stage);
  const [note, setNote] = useState("");
  const stages = resumeStages(run);
  const resume = async () => {
    if (action.busy) return;
    let notice: string | undefined;
    const ok = await action.run(
      async (by) => {
        const r = await client.resume(run.runId, by, run.repo, { ...(to === run.stage ? {} : { to }), note });
        notice = r.ok ? resumeNotice(run.runId, r.data?.drive) : undefined;
        return r;
      },
      { who: true, refused: "the run was not resumed" },
    );
    if (!ok) return;
    // Resumed, but nothing drives it: the person must know, so the card stays to say so.
    if (notice) action.say(notice);
    else onDone?.();
  };
  const close = async () => {
    if (action.busy || reason.trim() === "") return;
    const ok = await action.run(() => client.abort(run.runId, reason.trim(), run.repo), {
      refused: "the run was not closed",
    });
    if (ok) onDone?.();
  };
  return (
    <>
      {/* A system run blocked by an aborted child: its step can be retried, then the run resumed. */}
      <RetryAbortedSteps run={run} />
      <div className="resume-at">
        <label>
          <span className="dim">Resume at</span>
          <select aria-label="stage to resume at" value={to} onChange={(e) => setTo(e.target.value)}>
            {stages.map((s) => (
              <option key={s} value={s}>
                {s === run.stage ? `${s} (where it stopped)` : s}
              </option>
            ))}
          </select>
        </label>
        <label className="note">
          <span className="dim">Note for the agent (optional)</span>
          <input
            aria-label="note for the agent that works next"
            placeholder="what must be different this time; the next agent reads it"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>
      <p className="dim">
        Resume: <span data-testid="resume-plan">{resumePlan(run.stage, to)}</span>.
      </p>
      <div className="actions">
        <button type="button" className="primary" disabled={action.busy} onClick={() => void resume()}>
          Resume
        </button>
        <button type="button" disabled={action.busy} onClick={() => setClosing(!closing)}>
          Close run…
        </button>
        {children}
      </div>
      {closing ? (
        <form
          className="close"
          onSubmit={(e) => {
            e.preventDefault();
            void close();
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the field appears because closing needs a reason
            autoFocus
            aria-label="why the run is closed (required)"
            placeholder="why is the run closed? (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="submit" disabled={action.busy || reason.trim() === ""}>
            Close as aborted
          </button>
        </form>
      ) : null}
      <Notice {...action.notice} />
    </>
  );
}

export function EscalatedCard({
  run,
  onDone,
  onBriefing,
  onOpenChanges,
}: {
  readonly run: Run;
  onDone(): void;
  onBriefing(runId: string): void;
  onOpenChanges(runId: string): void;
}) {
  return (
    <article className="card escalated-card" aria-label="escalated run" data-testid="escalated-card">
      <h2>{run.task}</h2>
      <p className="dim">
        {run.runId}
        {run.repo ? ` · ${run.repo}` : ""} · stopped at {run.stage} {duration(run.elapsedMs)} after it started
      </p>
      <h3>Why it stopped</h3>
      <StopReason reason={run.reason} stop={run.stop} testId="escalated-reason" />
      <p>
        Remove the cause, then resume at the stage it stopped at or an earlier one. Or close it: it ends as
        aborted.
      </p>
      <EscalatedActions run={run} onDone={onDone}>
        <button type="button" className="ghost" onClick={() => onBriefing(run.runId)}>
          Briefing
        </button>
        <button type="button" className="ghost" onClick={() => onOpenChanges(run.runId)}>
          Changes
        </button>
      </EscalatedActions>
    </article>
  );
}
