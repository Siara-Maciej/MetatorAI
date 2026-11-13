/**
 * The Inbox: the one decision the sidebar's "Needs you" has picked, with everything needed to
 * take it here. With nothing to decide it says so; with no run at all it offers to start one.
 */
import { useState } from "react";
import { DecisionCard } from "../components/decision-card.tsx";
import { EscalatedCard } from "../components/escalated-card.tsx";
import { useDaemon } from "../daemon.tsx";
import { escalatedKey, isFirstRun, type NeedRow, plural } from "../model.ts";

export function InboxScreen({
  needs,
  picked,
  onAnswered,
  onOpenRun,
  onOpenChanges,
  onOverview,
  onStart,
  onForm,
}: {
  /** Everything that needs the person, as the sidebar lists it. */
  readonly needs: readonly NeedRow[];
  /** The row to show: the picked one, else the first. */
  readonly picked: NeedRow | undefined;
  /** An answer went through, or an escalated run was resumed or closed. */
  onAnswered(choices?: readonly string[]): void;
  onOpenRun(runId: string, pane?: string): void;
  onOpenChanges(runId: string): void;
  onOverview(runId: string): void;
  /** Starts a run from what the person wrote: the agent gets it as its first line. */
  onStart(task: string): void;
  onForm(): void;
}) {
  const { inbox, runs } = useDaemon();
  const item = picked ? inbox.find((i) => `${i.runId}/${i.question.id}` === picked.key) : undefined;
  const stopped =
    picked?.kind === "escalated"
      ? runs.find((r) => r.status === "escalated" && escalatedKey(r) === picked.key)
      : undefined;
  const inTerminal = needs.filter((n) => n.kind === "terminal");
  return (
    <div className="inbox">
      {item ? (
        <DecisionCard
          key={picked?.key}
          item={item}
          onAnswered={onAnswered}
          onOpenSession={onOverview}
          onOpenChanges={onOpenChanges}
        />
      ) : stopped ? (
        <EscalatedCard
          key={picked?.key}
          run={stopped}
          onDone={() => onAnswered()}
          onBriefing={onOverview}
          onOpenChanges={onOpenChanges}
        />
      ) : picked?.kind === "terminal" ? (
        <div className="empty">
          <h2>{inTerminal.length === 1 ? "1 run asks" : `${plural(inTerminal.length, "run")} ask`} in the terminal</h2>
          <p>
            There is no card to answer from: the agent wrote its question on its own screen. Open the run, take
            the keyboard and answer there.
          </p>
          <button type="button" className="primary" onClick={() => onOpenRun(picked.runId, picked.pane)}>
            Open the run
          </button>
        </div>
      ) : isFirstRun(runs, needs) ? (
        <FirstRun onStart={onStart} onForm={onForm} />
      ) : (
        <div className="empty">
          <h2>Inbox zero</h2>
          <p>Every run is working or finished. Open a run from the sidebar, or start a new one.</p>
        </div>
      )}
    </div>
  );
}

/** Nothing was ever started here: say what to do, or fill the form. */
function FirstRun({ onStart, onForm }: { onStart(task: string): void; onForm(): void }) {
  const [task, setTask] = useState("");
  return (
    <form
      className="first-run"
      data-testid="first-run"
      onSubmit={(e) => {
        e.preventDefault();
        if (task.trim() !== "") onStart(task.trim());
      }}
    >
      <h1>Describe a task</h1>
      <p className="muted">
        Say what to do in a sentence or two. The agent opens in a terminal, asks what is unclear and starts the
        run; every decision it needs from you comes here.
      </p>
      <textarea
        aria-label="Describe a task"
        rows={4}
        placeholder="for example: add a 10% discount to invoices over 1000, with a test"
        value={task}
        onChange={(e) => setTask(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && task.trim() !== "") onStart(task.trim());
        }}
      />
      <div className="actions">
        <button type="submit" className="primary" disabled={task.trim() === ""}>
          Start
        </button>
        <button type="button" onClick={onForm}>
          Use the form
        </button>
        <span className="faint">
          <kbd>ctrl+↵</kbd> starts
        </span>
      </div>
    </form>
  );
}
