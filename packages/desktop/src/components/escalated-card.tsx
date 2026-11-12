/**
 * An escalated run (F1, D9): why it stopped, and the two ways on. Resume puts it back at the stage
 * it escalated from and drives it; Close ends it as aborted, with the person's reason.
 */
import { useState } from "react";
import { useDaemon } from "../daemon.tsx";
import { duration, type Run, resumeNotice, resumePlan, resumeStages } from "../model.ts";
import { Notice } from "./common.tsx";

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
  const { client, who } = useDaemon();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const [to, setTo] = useState(run.stage);
  const [note, setNote] = useState("");
  const stages = resumeStages(run);
  const resume = async () => {
    if (busy) return;
    const by = await who();
    if (!by) return;
    setBusy(true);
    const r = await client.resume(run.runId, by, run.repo, { ...(to === run.stage ? {} : { to }), note });
    setBusy(false);
    if (!r.ok) {
      setError(`${r.error?.message ?? "the run was not resumed"}${r.error?.hint ? ` ${r.error.hint}` : ""}`);
      return;
    }
    const notice = resumeNotice(run.runId, r.data?.drive);
    setError(notice);
    if (!notice) onDone();
  };
  const close = async () => {
    if (busy || reason.trim() === "") return;
    setBusy(true);
    const r = await client.abort(run.runId, reason.trim(), run.repo);
    setBusy(false);
    if (!r.ok) setError(r.error?.message ?? "the run was not closed");
    else onDone();
  };
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
        The run tried this stage as often as its workflow allows. Remove the cause, then resume:{" "}
        <span data-testid="resume-plan">{resumePlan(run.stage, to)}</span>. Or close it: it ends as aborted.
      </p>
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
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void resume()}>
          Resume
        </button>
        <button type="button" disabled={busy} onClick={() => setClosing(!closing)}>
          Close run…
        </button>
        <button type="button" className="ghost" onClick={() => onBriefing(run.runId)}>
          Briefing
        </button>
        <button type="button" className="ghost" onClick={() => onOpenChanges(run.runId)}>
          Changes
        </button>
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
          <button type="submit" disabled={busy || reason.trim() === ""}>
            Close as aborted
          </button>
        </form>
      ) : null}
      <Notice text={error} onClose={() => setError(undefined)} />
    </article>
  );
}
