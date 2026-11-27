/**
 * An escalated run (F1, D9): why it stopped, and the two ways on. Resume puts it back at the stage
 * it escalated from, or at an earlier one it worked, with a note for the next agent, and drives it;
 * Close ends it as aborted, with the person's reason. The card
 * is the Inbox's; the session screen of an escalated run shows the same actions in its bar.
 *
 * What the actions keep is the Escalated store (ADR-0113, `state.ts`); each field reads only its
 * own value, so writing the note or the reason draws that field, not the card.
 */

import { useDaemonStore } from "../../shared/daemon/daemon.tsx";
import { duration } from "../../shared/model/format.ts";
import type { Run } from "../../shared/model/runs.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { RetryAbortedSteps } from "../plans/retry-step.tsx";
import { StopReason } from "../runs/stop-reason.tsx";
import { resumePlan, resumeStages } from "./model.ts";
import { Escalated, useEscalated, useEscalatedApi } from "./state.ts";

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
  const daemon = useDaemonStore();
  return (
    <ScopeProvider store={Escalated} init={{ daemon, stage: run.stage }}>
      {/* A system run blocked by an aborted child: its step can be retried, then the run resumed. */}
      <RetryAbortedSteps run={run} />
      <div className="resume-at">
        <StageSelect run={run} />
        <NoteField />
      </div>
      <ResumePlanLine stage={run.stage} />
      <div className="actions">
        <ResumeButton run={run} onDone={onDone} />
        <CloseToggle />
        {children}
      </div>
      <CloseForm run={run} onDone={onDone} />
      <EscalatedNotice />
    </ScopeProvider>
  );
}

function StageSelect({ run }: { readonly run: Run }) {
  const to = useEscalated((s) => s.to);
  const setTo = useEscalated((s) => s.setTo);
  return (
    <label>
      <span className="dim">Resume at</span>
      <select aria-label="stage to resume at" value={to} onChange={(e) => setTo(e.target.value)}>
        {resumeStages(run).map((s) => (
          <option key={s} value={s}>
            {s === run.stage ? `${s} (where it stopped)` : s}
          </option>
        ))}
      </select>
    </label>
  );
}

export function NoteField() {
  const note = useEscalated((s) => s.note);
  const setNote = useEscalated((s) => s.setNote);
  return (
    <label className="note">
      <span className="dim">Note for the agent (optional)</span>
      <input
        aria-label="note for the agent that works next"
        placeholder="what must be different this time; the next agent reads it"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
    </label>
  );
}

export function ResumePlanLine({ stage }: { readonly stage: string }) {
  const to = useEscalated((s) => s.to);
  return (
    <p className="dim">
      Resume: <span data-testid="resume-plan">{resumePlan(stage, to)}</span>.
    </p>
  );
}

function ResumeButton({ run, onDone }: { readonly run: Run; onDone?: (() => void) | undefined }) {
  const busy = useEscalated((s) => s.busy);
  const api = useEscalatedApi();
  return (
    <Button variant="primary" disabled={busy} onClick={() => void api.getState().resume(run, onDone)}>
      Resume
    </Button>
  );
}

function CloseToggle() {
  const busy = useEscalated((s) => s.busy);
  const toggleClosing = useEscalated((s) => s.toggleClosing);
  return (
    <Button disabled={busy} onClick={toggleClosing}>
      Close run…
    </Button>
  );
}

function CloseForm({ run, onDone }: { readonly run: Run; onDone?: (() => void) | undefined }) {
  const closing = useEscalated((s) => s.closing);
  const api = useEscalatedApi();
  return closing ? (
    <form
      className="close"
      onSubmit={(e) => {
        e.preventDefault();
        void api.getState().close(run, onDone);
      }}
    >
      <CloseReason />
      <CloseSubmit />
    </form>
  ) : null;
}

function CloseReason() {
  const reason = useEscalated((s) => s.reason);
  const setReason = useEscalated((s) => s.setReason);
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the field appears because closing needs a reason
      autoFocus
      aria-label="why the run is closed (required)"
      placeholder="why is the run closed? (required)"
      value={reason}
      onChange={(e) => setReason(e.target.value)}
    />
  );
}

function CloseSubmit() {
  const blocked = useEscalated((s) => s.busy || s.reason.trim() === "");
  return (
    <Button type="submit" disabled={blocked}>
      Close as aborted
    </Button>
  );
}

function EscalatedNotice() {
  const notice = useEscalated((s) => s.notice);
  const closeNotice = useEscalated((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
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
        <Button variant="ghost" onClick={() => onBriefing(run.runId)}>
          Briefing
        </Button>
        <Button variant="ghost" onClick={() => onOpenChanges(run.runId)}>
          Changes
        </Button>
      </EscalatedActions>
    </article>
  );
}
