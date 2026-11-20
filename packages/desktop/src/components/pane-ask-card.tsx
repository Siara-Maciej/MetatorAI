/**
 * The card of a pane's question on Home (ADR-0091): a pane without a run (the intake chat) asks,
 * its host for leave to run a command or its agent in words. The card shows the prompt, the pane
 * and its repository, and the choices; a choice is sent with `POST /panes/:pane/answer`, and the
 * daemon types it into the pane (a menu's number, the agent's words). Attach goes to the pane.
 */
import { useState } from "react";
import type { PaneAsk } from "../api.ts";
import { useDaemon } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { CommandText, commandOf } from "./command-text.tsx";
import { Notice } from "./common.tsx";

/** The choice that sends the person to the pane instead of answering here. */
const ATTACH = "Attach and answer in the pane";

export function PaneAskCard({
  ask,
  onAnswered,
  onOpenPane,
}: {
  readonly ask: PaneAsk;
  onAnswered(choices: readonly string[]): void;
  /** Opens the pane in Terminals (Attach). */
  onOpenPane(ask: PaneAsk): void;
}) {
  const { client } = useDaemon();
  const action = useAction();
  const [choice, setChoice] = useState<string>();
  const [words, setWords] = useState("");
  const q = ask.question;
  const other = choice === "Other";
  const send = async () => {
    if (!choice) return;
    const done = await action.run(
      (by) =>
        client.answerPane(
          {
            paneId: ask.paneId,
            question: q.id,
            choices: other ? [] : [choice],
            by,
            ...(other ? { text: words.trim() } : {}),
          },
          ask.repo,
        ),
      { who: true },
    );
    if (!done) return;
    if (choice === ATTACH) onOpenPane(ask);
    onAnswered(other ? [words.trim()] : [choice]);
  };
  return (
    <article className="card pane-ask" aria-label="pane question" data-testid={`pane-ask-${ask.paneId}`}>
      <h1>
        {q.source === "permission" || commandOf(q) ? (
          <CommandText prompt={q.prompt} command={commandOf(q)} />
        ) : (
          q.prompt
        )}
      </h1>
      <div className="muted" data-testid="pane-asker">
        {q.source === "agent" ? "The agent" : `${ask.host}`} asks in the {ask.label} pane
        {ask.repo ? ` of ${ask.repo}` : ""}, before any run: answer here and it is typed there.
      </div>
      <div className="decide-bar">
        <fieldset className="options">
          <legend className="dim">options</legend>
          {q.options.map((o) => (
            <label key={o.label} className="option">
              <input
                type="radio"
                name={`pane-ask-${q.id}`}
                checked={choice === o.label}
                onChange={() => setChoice(o.label)}
              />
              <span className="label">{o.label}</span>
              {o.description ? <span className="faint"> {o.description}</span> : null}
            </label>
          ))}
        </fieldset>
        {other ? (
          <label className="reason">
            <span className="amber">your words</span>
            <textarea
              aria-label="your words"
              rows={2}
              value={words}
              onChange={(e) => setWords(e.target.value)}
            />
          </label>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={!choice || action.busy || (other && words.trim() === "")}
            onClick={() => void send()}
          >
            Send
          </button>
          <button type="button" onClick={() => onOpenPane(ask)}>
            Open the pane
          </button>
        </div>
      </div>
      <Notice {...action.notice} />
      <details className="card-details" data-testid="card-details">
        <summary>Details</summary>
        <div className="ctx">
          <span className="mono">{q.id}</span>
          <span className="mono">pane {ask.paneId}</span>
          {ask.repo ? <span className="mono">{ask.repo}</span> : null}
          <span className="mono">{ask.host}</span>
        </div>
      </details>
    </article>
  );
}
