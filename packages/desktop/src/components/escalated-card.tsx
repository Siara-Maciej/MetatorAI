/**
 * An escalated run (F1, D9): why it stopped, and the two ways on. Resume puts it back at the stage
 * it escalated from and drives it; Close ends it as aborted, with the person's reason. The card
 * is the Inbox's; the session screen of an escalated run shows the same actions in its bar.
 */
import { useState } from "react";
import { useDaemon } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { duration, type Run, resumeNotice } from "../model.ts";
import { Notice } from "./common.tsx";

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
  const { client } = useDaemon();
  const action = useAction();
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const resume = async () => {
    if (action.busy) return;
    let notice: string | undefined;
    const ok = await action.run(
      async (by) => {
        const r = await client.resume(run.runId, by, run.repo);
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
      <div className="reason-text mono" data-testid="escalated-reason">
        {run.reason ?? "The run recorded no reason. Its briefing shows what happened last."}
      </div>
      <p>
        The run tried this stage as often as its workflow allows. Remove the cause, then resume: the run goes
        back to {run.stage} with a fresh set of tries and is driven on. Or close it: it ends as aborted.
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
