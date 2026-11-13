/** Screen 1: the decision queue. An empty inbox is the end of the work. */
import { useEffect, useState } from "react";
import { Chips } from "../components/chips.tsx";
import { DecisionCard } from "../components/decision-card.tsx";
import { EscalatedCard } from "../components/escalated-card.tsx";
import { useDaemon } from "../daemon.tsx";
import { duration, escalatedKey, inboxChips, plainKey, plural, questionKind, runCounts } from "../model.ts";

const key = (i: { runId: string; question: { id: string } }) => `${i.runId}/${i.question.id}`;

export function InboxScreen({
  pick,
  onOpenSession,
  onOpenChanges,
  onBriefing,
}: {
  /** The item to show first (`<run>/<question>`, from the workbench's toast). */
  readonly pick?: string | undefined;
  onOpenSession(runId: string, pane?: string): void;
  onOpenChanges(runId: string): void;
  onBriefing(runId: string): void;
}) {
  const { inbox, runs } = useDaemon();
  const [selected, setSelected] = useState<string | undefined>(pick);
  useEffect(() => {
    if (pick) setSelected(pick);
  }, [pick]);
  // Sessions whose agent asks on its terminal (D2): no card to answer from, the pane is the place.
  const inTerminal = runs.filter((r) => r.terminalAsk !== undefined);
  // Escalated runs (F1): each is a card with the reason it stopped, Resume and Close.
  const escalated = runs.filter((r) => r.status === "escalated");
  const stopped = escalated.find((r) => escalatedKey(r) === selected);
  const current = stopped ? undefined : (inbox.find((i) => key(i) === selected) ?? inbox[0]);
  const shownStopped = stopped ?? (current ? undefined : escalated[0]);
  // The heading counts runs, as the top bar does; the rows below may be more (two questions of one run).
  const counts = runCounts(runs);
  const rows = inbox.length + inTerminal.length + escalated.length;
  useEffect(() => {
    if (current && key(current) !== selected) setSelected(key(current));
  }, [current, selected]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = plainKey(e);
      if (k === "g" && inbox.length > 1) {
        const i = inbox.findIndex((x) => key(x) === selected);
        setSelected(key(inbox[(i + 1) % inbox.length] as (typeof inbox)[number]));
      }
      if (k === "o" && current) onOpenSession(current.runId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inbox, selected, current, onOpenSession]);
  return (
    <div className="inbox">
      <div className="needs">
        <h2 data-testid="needs-count">
          Needs you · {counts.needYou}
          {rows !== counts.needYou ? <span className="dim"> · {plural(rows, "item")}</span> : null}
        </h2>
        {inbox.map((i) => (
          <button
            type="button"
            key={key(i)}
            className="item"
            aria-current={key(i) === selected ? "true" : undefined}
            onClick={() => setSelected(key(i))}
          >
            <span className="l1">
              <span className={`kind ${questionKind(i.question)}`}>{questionKind(i.question)}</span>
              {i.question.card?.group ? (
                <span className="chip blue">
                  step {i.question.card.group.step}/{i.question.card.group.of}
                </span>
              ) : null}
              <span className="dim wait">{duration(i.waitedMs)}</span>
            </span>
            <span className="title" title={i.question.prompt}>
              {i.question.prompt}
            </span>
            <span className="sub dim">
              {i.runId}
              {i.repo ? ` · ${i.repo}` : ""}
            </span>
            <Chips items={inboxChips(i)} />
          </button>
        ))}
        {inTerminal.map((r) => (
          <button
            type="button"
            key={r.runId}
            className="ask-row"
            data-testid={`terminal-ask-${r.runId}`}
            title="The agent asks on its terminal: open the pane and answer there"
            onClick={() => onOpenSession(r.runId, r.terminalAsk)}
          >
            <span className="l1">
              <span className="kind TERMINAL">TERMINAL</span>
              <span className="open">Open ›</span>
            </span>
            <span className="title" title={r.task}>
              {r.task}
            </span>
            <span className="sub dim">
              answers in its terminal · {r.stage}
              {r.repo ? ` · ${r.repo}` : ""}
            </span>
          </button>
        ))}
        {escalated.map((r) => (
          <button
            type="button"
            key={escalatedKey(r)}
            className="item"
            data-testid={`escalated-${r.runId}`}
            aria-current={shownStopped && escalatedKey(shownStopped) === escalatedKey(r) ? "true" : undefined}
            onClick={() => setSelected(escalatedKey(r))}
          >
            <span className="l1">
              <span className="kind ESCALATED">ESCALATED</span>
            </span>
            <span className="title" title={r.task}>
              {r.task}
            </span>
            <span className="sub dim">
              stopped at {r.stage} · {r.runId}
              {r.repo ? ` · ${r.repo}` : ""}
            </span>
          </button>
        ))}
        {inbox.length === 0 && inTerminal.length === 0 && escalated.length === 0 ? (
          <div className="empty">Nothing needs you.</div>
        ) : null}
      </div>
      {current ? (
        <DecisionCard
          key={key(current)}
          item={current}
          onAnswered={() => setSelected(undefined)}
          onOpenSession={onOpenSession}
          onOpenChanges={onOpenChanges}
        />
      ) : shownStopped ? (
        <EscalatedCard
          key={escalatedKey(shownStopped)}
          run={shownStopped}
          onDone={() => setSelected(undefined)}
          onBriefing={onBriefing}
          onOpenChanges={onOpenChanges}
        />
      ) : inTerminal.length > 0 ? (
        <div className="empty">
          <h2>{inTerminal.length === 1 ? "1 run asks" : `${inTerminal.length} runs ask`} in the terminal</h2>
          <p>
            There is no card to answer from: the agent wrote its question on its own screen. Open the session,
            take the keyboard and answer there.
          </p>
          <button
            type="button"
            className="primary"
            onClick={() => onOpenSession(inTerminal[0]?.runId as string, inTerminal[0]?.terminalAsk)}
          >
            Open {inTerminal.length === 1 ? "the session" : "the first one"}
          </button>
        </div>
      ) : (
        <div className="empty">
          <h2>Inbox zero</h2>
          <p>Every run is working or finished. Open a run from the panel, or start a new session.</p>
        </div>
      )}
    </div>
  );
}
