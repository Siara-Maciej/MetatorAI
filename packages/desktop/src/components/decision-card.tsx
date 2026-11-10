/**
 * The decision card (screen 1, spec §6.3): everything a person needs to answer without opening
 * the session, composed by the daemon; the app only draws it and sends the answer back.
 */
import { useEffect, useState } from "react";
import type { InboxItem } from "../api.ts";
import { useDaemon } from "../daemon.tsx";
import { answerCommand, duration, questionKind } from "../model.ts";
import { Chip } from "./chips.tsx";

export function DecisionCard({
  item,
  onAnswered,
  onOpenSession,
}: {
  readonly item: InboxItem;
  onAnswered(): void;
  onOpenSession(runId: string): void;
}) {
  const { client, me, setMe } = useDaemon();
  const q = item.question;
  const card = q.card;
  const [choice, setChoice] = useState<string | undefined>(card?.recommended ?? q.options[0]?.label);
  const [note, setNote] = useState("");
  const [name, setName] = useState(me);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setChoice(card?.recommended ?? q.options[0]?.label);
    setNote("");
    setError(undefined);
  }, [card?.recommended, q.options[0]?.label]);
  const send = async (label: string | undefined) => {
    if (!label) return;
    if (!name.trim()) {
      setError("say who you are first");
      return;
    }
    setBusy(true);
    setMe(name.trim());
    // From the card, without opening the session: the daemon notes the origin for 11a.
    const r = await client.answer(
      q.runId,
      q.id,
      [label],
      name.trim(),
      note.trim() || undefined,
      "inbox",
      item.repo,
    );
    setBusy(false);
    if (!r.ok) setError(r.error?.message ?? "the answer was refused");
    else onAnswered();
  };
  const others = q.options.filter((o) => o.label !== choice);
  return (
    <article className="card" aria-label="decision card">
      <div className="ctx">
        <span className="mono">{q.id}</span>
        <span>{questionKind(q)}</span>
        <span>{item.stage}</span>
        {item.repo ? <span>{item.repo}</span> : null}
        <span className="mono">{q.runId}</span>
        {q.agent ? <span>{q.agent}</span> : null}
      </div>
      <h1>{q.prompt}</h1>
      <div className="chips">
        {card ? (
          <Chip tone={card.reversible ? "green" : "red"}>
            {card.reversible ? "reversible" : "not reversible"}
          </Chip>
        ) : null}
        {card?.blastRadius ? (
          <Chip tone="violet">
            blast radius {card.blastRadius.files} files
            {card.blastRadius.areas.length > 0 ? ` · ${card.blastRadius.areas.join(", ")}` : ""}
          </Chip>
        ) : null}
        <Chip tone="amber">waiting {duration(item.waitedMs)}</Chip>
        {item.driving ? <Chip tone="amber">agent idle</Chip> : null}
        {card?.costOfDelay?.map((c) => (
          <Chip key={c}>{c}</Chip>
        ))}
        {card?.group ? (
          <Chip tone="blue">
            feature step {card.group.step}/{card.group.of}
          </Chip>
        ) : null}
      </div>
      {card ? (
        <section>
          <h3>Goal</h3>
          <div>{card.task}</div>
        </section>
      ) : null}
      {card?.soFar?.length ? (
        <section>
          <h3>Since you left</h3>
          <ul>
            {card.soFar.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {card && (card.done.length > 0 || card.artifacts.length > 0) ? (
        <section>
          <h3>Proposal and evidence</h3>
          {card.done.length > 0 ? <div className="muted">done: {card.done.join(" → ")}</div> : null}
          {card.artifacts.length > 0 ? (
            <div className="muted">
              see:{" "}
              {card.artifacts.map((a) => (
                <code key={a}>{a} </code>
              ))}
            </div>
          ) : null}
          {card.evidence?.length ? (
            <ul>
              {card.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <section>
        <h3>Options</h3>
        <fieldset className="options">
          <legend className="dim">options</legend>
          {q.options.map((o) => (
            <button
              type="button"
              key={o.label}
              className="option"
              aria-pressed={choice === o.label}
              onClick={() => setChoice(o.label)}
            >
              <div className="label">
                <span>{o.label}</span>
                {card?.recommended === o.label ? <span className="rec">RECOMMENDED</span> : null}
              </div>
              {o.description ? <div className="cons">{o.description}</div> : null}
              {card?.consequences?.[o.label] ? (
                <div className="cons">→ {card.consequences[o.label]}</div>
              ) : null}
            </button>
          ))}
        </fieldset>
      </section>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !choice}
          onClick={() => void send(choice)}
        >
          {choice ?? "choose"} ⏎
        </button>
        {others[0] ? (
          <button type="button" disabled={busy} onClick={() => void send(others[0]?.label)}>
            {others[0].label}
          </button>
        ) : null}
        <button type="button" onClick={() => onOpenSession(q.runId)}>
          Open session · o
        </button>
        <input
          aria-label="note"
          placeholder="a note for the log (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <input
          aria-label="your name"
          placeholder="your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ maxWidth: 140 }}
        />
      </div>
      {error ? <div className="banner">{error}</div> : null}
      <div className="footer-cmd mono">writes: {answerCommand(q, choice ?? "…", name.trim())}</div>
    </article>
  );
}
