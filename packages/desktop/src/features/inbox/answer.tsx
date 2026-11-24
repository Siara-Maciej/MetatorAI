/**
 * Answering a question (D8), the same everywhere it can be answered: which options are chosen
 * (several for a multi-select question), the person's own words where Reject or Other promise
 * them, and the request. The decision card draws its own layout over `useAnswer`; a step's
 * Overview and the Terminal tab's side box use `QuickAnswer`, in the same pattern.
 */
import { useEffect, useState } from "react";
import type { Question } from "../../shared/api/api.ts";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { routeHash } from "../../shared/model/route.ts";
import { opensDiff } from "../../shared/model/stage1.ts";
import { Notice } from "../../ui/notice.tsx";
import { canAnswer, needsReason, toggleChoice } from "./model.ts";

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
    /** The answer was refused: what the daemon said (the card may close before it is read). */
    onRefused?(message: string): void;
  },
) {
  const { client, who } = useDaemon("client", "who");
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
  /** `words`: the reason given elsewhere on the card (Ask for changes), instead of the note field. */
  const send = async (picked: readonly string[] = choices, words?: string) => {
    // "Open diff" on a quick change's card is no answer: the run's change opens, the card stays.
    if (opensDiff(picked)) {
      window.location.hash = routeHash({ screen: "run", runId: q.runId, tab: "changes" });
      return;
    }
    const said = words ?? text;
    if (busy || !canAnswer(picked, said)) return;
    const by = await who();
    if (!by) return;
    setBusy(true);
    const r = await client.answer(
      {
        runId: q.runId,
        question: q.id,
        choices: picked,
        by,
        text: said.trim() || undefined,
        origin: options.origin,
      },
      repo,
    );
    setBusy(false);
    if (!r.ok) {
      const said = r.error?.message ?? "the answer was refused";
      setError(said);
      options.onRefused?.(said);
    } else {
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
 * A question answered in a small place (a step's Overview, the Terminal tab's side box), the way
 * Home answers it: the options are the choice (the recommended one chosen first), one button
 * sends the chosen one, and Reject or Other ask for their reason inline before it can be sent.
 */
export function QuickAnswer({
  question: q,
  repo,
  max,
  onDone,
}: {
  readonly question: Question;
  readonly repo: string | undefined;
  /** Show only the first options (a one-line place). */
  readonly max?: number;
  /** After the answer is taken, with what was chosen. */
  onDone(choices: readonly string[]): void;
}) {
  const recommended = q.card?.recommended;
  const a = useAnswer(q, repo, {
    initial: !q.multiSelect && recommended ? [recommended] : [],
    onDone,
  });
  return (
    <form
      className="quick-answer"
      data-testid="quick-answer"
      onSubmit={(e) => {
        e.preventDefault();
        void a.send();
      }}
    >
      <div className="chips">
        {q.options.slice(0, max ?? q.options.length).map((o) => (
          <button
            type="button"
            key={o.label}
            className="option-chip"
            aria-pressed={a.choices.includes(o.label)}
            title={o.description}
            disabled={a.busy}
            onClick={() => a.toggle(o.label)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {a.reason ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: the field appears because the chosen option needs it
          autoFocus
          className="reason"
          aria-label="reason (required)"
          placeholder={`Reason for ${a.choices.find((c) => needsReason([c])) ?? "this answer"} (required)`}
          value={a.text}
          onChange={(e) => a.setText(e.target.value)}
        />
      ) : q.multiSelect && a.choices.length === 0 ? (
        <span className="dim">choose one or more</span>
      ) : null}
      <button type="submit" className="primary" disabled={!a.ready}>
        {a.choices.length > 0 ? a.choices.join(", ") : "Choose"} ⏎
      </button>
      <Notice text={a.error} onClose={a.clearError} />
    </form>
  );
}
