/**
 * Answering a question (D8), the same everywhere it can be answered: which options are chosen
 * (several for a multi-select question), the person's own words where Reject or Other promise
 * them, and the request. The decision card draws its own layout over `useAnswer`; the session's
 * side box and the plan's bar use `QuickAnswer`.
 */
import { useEffect, useState } from "react";
import type { Question } from "../api.ts";
import { useDaemon } from "../daemon.tsx";
import { canAnswer, needsReason, toggleChoice } from "../model.ts";
import { Notice } from "./common.tsx";

export function useAnswer(
  q: Question,
  repo: string | undefined,
  options: {
    /** What is chosen before the person touches anything (the card: the recommended option). */
    readonly initial?: readonly string[];
    /** From the decision card, without opening the session: what the daemon counts. */
    readonly origin?: "inbox";
    /** The answer went through, with what was chosen. */
    onDone(choices: readonly string[]): void;
  },
) {
  const { client, who } = useDaemon();
  const initial = (options.initial ?? []).join("\n");
  const [choices, setChoices] = useState<readonly string[]>(options.initial ?? []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Another question in the same place starts clean.
  const id = `${q.runId}/${q.id}`;
  useEffect(() => {
    void id;
    setChoices(initial === "" ? [] : initial.split("\n"));
    setText("");
    setError(undefined);
  }, [id, initial]);
  const send = async (picked: readonly string[] = choices) => {
    if (busy || !canAnswer(picked, text)) return;
    const by = await who();
    if (!by) return;
    setBusy(true);
    const r = await client.answer(
      {
        runId: q.runId,
        question: q.id,
        choices: picked,
        by,
        text: text.trim() || undefined,
        origin: options.origin,
      },
      repo,
    );
    setBusy(false);
    if (!r.ok) setError(r.error?.message ?? "the answer was refused");
    else {
      setError(undefined);
      options.onDone(picked);
    }
  };
  return {
    choices,
    toggle: (label: string) => setChoices((c) => toggleChoice(c, label, q.multiSelect)),
    text,
    setText,
    busy,
    error,
    clearError: () => setError(undefined),
    /** The chosen options promise the person's own words. */
    reason: needsReason(choices),
    ready: canAnswer(choices, text) && !busy,
    send,
  };
}

/**
 * The options as buttons. A click on a plain option of a single-choice question is the answer;
 * Reject, Other and every option of a multi-select question are chosen first, then sent with
 * the reason field and "Send".
 */
export function QuickAnswer({
  question: q,
  repo,
  max,
  onDone,
}: {
  readonly question: Question;
  readonly repo: string | undefined;
  /** Show only the first options (the plan's bar is one line). */
  readonly max?: number;
  onDone(): void;
}) {
  const a = useAnswer(q, repo, { onDone });
  const recommended = q.card?.recommended;
  const staged = q.multiSelect || a.reason;
  return (
    <div className="quick-answer" data-testid="quick-answer">
      <div className="chips">
        {q.options.slice(0, max ?? q.options.length).map((o) => (
          <button
            type="button"
            key={o.label}
            className={o.label === recommended && a.choices.length === 0 ? "primary" : undefined}
            aria-pressed={a.choices.includes(o.label)}
            title={o.description}
            disabled={a.busy}
            onClick={() => {
              if (!q.multiSelect && !needsReason([o.label])) void a.send([o.label]);
              else a.toggle(o.label);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      {staged ? (
        <form
          className="reason"
          onSubmit={(e) => {
            e.preventDefault();
            void a.send();
          }}
        >
          {q.multiSelect && !a.reason ? (
            <span className="dim">choose one or more</span>
          ) : (
            <input
              // biome-ignore lint/a11y/noAutofocus: the field appears because the chosen option needs it
              autoFocus
              aria-label="reason (required)"
              placeholder={`why ${a.choices.find((c) => needsReason([c])) ?? ""}? (required)`}
              value={a.text}
              onChange={(e) => a.setText(e.target.value)}
            />
          )}
          <button type="submit" className="primary" disabled={!a.ready}>
            Send{q.multiSelect && a.choices.length > 0 ? ` ${a.choices.length}` : ""}
          </button>
        </form>
      ) : null}
      <Notice text={a.error} onClose={a.clearError} />
    </div>
  );
}
