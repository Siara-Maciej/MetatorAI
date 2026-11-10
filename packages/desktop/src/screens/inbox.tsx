/** Screen 1: the decision queue. An empty inbox is the end of the work. */
import { useEffect, useState } from "react";
import { Chips } from "../components/chips.tsx";
import { DecisionCard } from "../components/decision-card.tsx";
import { useDaemon } from "../daemon.tsx";
import { duration, inboxChips, questionKind } from "../model.ts";

const key = (i: { runId: string; question: { id: string } }) => `${i.runId}/${i.question.id}`;

export function InboxScreen({
  onOpenSession,
  onBriefing,
}: {
  onOpenSession(runId: string): void;
  onBriefing(runId: string): void;
}) {
  const { inbox, runs } = useDaemon();
  const [selected, setSelected] = useState<string>();
  const current = inbox.find((i) => key(i) === selected) ?? inbox[0];
  useEffect(() => {
    if (current && key(current) !== selected) setSelected(key(current));
  }, [current, selected]);
  const escalated = runs.filter((r) => r.attention === "escalated");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "g" && inbox.length > 1) {
        const i = inbox.findIndex((x) => key(x) === selected);
        setSelected(key(inbox[(i + 1) % inbox.length] as (typeof inbox)[number]));
      }
      if (e.key === "o" && current) onOpenSession(current.runId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inbox, selected, current, onOpenSession]);
  return (
    <div className="inbox">
      <div className="needs">
        <h2>Needs you · {inbox.length}</h2>
        {inbox.map((i) => (
          <button
            type="button"
            key={key(i)}
            className="item"
            aria-current={key(i) === selected ? "true" : undefined}
            onClick={() => setSelected(key(i))}
          >
            <div>
              <span className={`kind ${questionKind(i.question)}`}>{questionKind(i.question)}</span>
              {i.question.card?.group ? (
                <span className="chip blue" style={{ marginLeft: 6 }}>
                  F · {i.question.card.group.step}/{i.question.card.group.of}
                </span>
              ) : null}
              <span className="dim" style={{ float: "right" }}>
                {duration(i.waitedMs)}
              </span>
            </div>
            <div className="title">{i.question.prompt}</div>
            <div className="sub dim">
              {i.runId}
              {i.repo ? ` · ${i.repo}` : ""}
            </div>
            <Chips items={inboxChips(i)} />
          </button>
        ))}
        {inbox.length === 0 ? <div className="empty">Nothing needs you.</div> : null}
        {escalated.length > 0 ? (
          <div className="info">
            {escalated.length} escalated:{" "}
            {escalated.map((r) => (
              <span key={r.runId}>
                <button type="button" className="ghost" onClick={() => onBriefing(r.runId)}>
                  briefing
                </button>
                <button type="button" className="ghost" onClick={() => onOpenSession(r.runId)}>
                  terminal
                </button>{" "}
                <span className="mono">{r.runId}</span>{" "}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {current ? (
        <DecisionCard
          key={key(current)}
          item={current}
          onAnswered={() => setSelected(undefined)}
          onOpenSession={onOpenSession}
        />
      ) : (
        <div className="empty">
          <h2>Inbox zero</h2>
          <p>Every session is working or finished. Open a session from the panel, or start a new one.</p>
        </div>
      )}
    </div>
  );
}
