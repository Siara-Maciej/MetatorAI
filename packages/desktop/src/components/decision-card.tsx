/**
 * The decision card (screen 1, spec §6.3): everything a person needs to answer without opening
 * the session, composed by the daemon; the app only draws it and sends the answer back.
 */
import { useEffect, useRef } from "react";
import type { InboxItem } from "../api.ts";
import { useDaemon } from "../daemon.tsx";
import { answerCommand, duration, needsReason, questionKind } from "../model.ts";
import { useAnswer } from "./answer.tsx";
import { Chip } from "./chips.tsx";
import { Notice } from "./common.tsx";

export function DecisionCard({
  item,
  onAnswered,
  onOpenSession,
  onOpenChanges,
}: {
  readonly item: InboxItem;
  onAnswered(): void;
  onOpenSession(runId: string): void;
  /** The run's change, straight from the card: what the decision is about. */
  onOpenChanges(runId: string): void;
}) {
  const { me } = useDaemon();
  const q = item.question;
  const card = q.card;
  // The recommended option is chosen first; a multi-select question starts with nothing chosen.
  const first = card?.recommended ?? q.options[0]?.label;
  const a = useAnswer(q, item.repo, {
    initial: q.multiSelect || !first ? [] : [first],
    // From the card, without opening the session: the daemon notes the origin.
    origin: "inbox",
    onDone: onAnswered,
  });
  const choice = a.choices[0];
  const reasonField = useRef<HTMLInputElement>(null);
  // Enter sends the selected answer (the ⏎ on the button), unless a field or a button has the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || !a.ready) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLButtonElement ||
        e.target instanceof HTMLAnchorElement
      )
        return;
      e.preventDefault();
      void a.send();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const others = q.multiSelect ? [] : q.options.filter((o) => o.label !== choice);
  const second = others[0];
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
      <h1 className={q.prompt.length > 160 ? "long" : undefined}>{q.prompt}</h1>
      <div className="chips">
        {card ? (
          <Chip tone={card.reversible ? "green" : "red"}>
            {card.reversible ? "reversible" : "not reversible"}
          </Chip>
        ) : null}
        {card?.blastRadius ? (
          <Chip tone="violet">
            touches {card.blastRadius.files} file{card.blastRadius.files === 1 ? "" : "s"}
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
            step {card.group.step} of {card.group.of}
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
        <h3>Options{q.multiSelect ? " · choose one or more" : ""}</h3>
        <fieldset className="options">
          <legend className="dim">options</legend>
          {q.options.map((o) => (
            <button
              type="button"
              key={o.label}
              className="option"
              aria-pressed={a.choices.includes(o.label)}
              onClick={() => a.toggle(o.label)}
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
      <label className="reason">
        <span className={a.reason ? "amber" : "dim"}>
          {a.reason
            ? `Reason for ${a.choices.find((c) => needsReason([c])) ?? "this answer"} (required)`
            : "Note (optional)"}
        </span>
        <input
          ref={reasonField}
          aria-label={a.reason ? "reason (required)" : "note"}
          placeholder={a.reason ? "the run gets your words; say what must change" : "a note for the log"}
          value={a.text}
          onChange={(e) => a.setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && a.ready) void a.send();
          }}
        />
      </label>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!a.ready}
          title={a.reason && !a.ready ? "write the reason first" : undefined}
          onClick={() => void a.send()}
        >
          {a.choices.length > 0 ? a.choices.join(", ") : "choose"} ⏎
        </button>
        {second ? (
          <button
            type="button"
            disabled={a.busy}
            onClick={() => {
              // An answer that needs a reason is chosen, and the cursor goes to the reason.
              if (needsReason([second.label]) && a.text.trim() === "") {
                a.toggle(second.label);
                reasonField.current?.focus();
              } else void a.send([second.label]);
            }}
          >
            {second.label}
          </button>
        ) : null}
        <span className="spacer" />
        <button type="button" onClick={() => onOpenChanges(q.runId)}>
          Changes
        </button>
        <button type="button" onClick={() => onOpenSession(q.runId)}>
          Open session · o
        </button>
      </div>
      <Notice text={a.error} onClose={a.clearError} />
      <div className="footer-cmd mono">writes: {answerCommand(q, a.choices, me, a.text)}</div>
    </article>
  );
}
