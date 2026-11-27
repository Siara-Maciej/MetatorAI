/**
 * Answering a question (D8), the same everywhere it can be answered: which options are chosen
 * (several for a multi-select question), the person's own words where Reject or Other promise
 * them, and the request. What is chosen and written is the Answer store (`answer-state.ts`), made
 * for one question by `AnswerScope`; the decision card draws its own layout over it, and a step's
 * Overview and the Terminal tab's side box use `QuickAnswer`, in the same pattern.
 */

import type { ReactNode } from "react";
import type { Question } from "../../shared/api/api.ts";
import { useDaemonStore } from "../../shared/daemon/daemon.tsx";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { Answer, chosenOf, readyOf, reasonOf, useAnswer, useAnswerApi } from "./answer-state.ts";
import { needsReason } from "./model.ts";

/**
 * The answer's store for one question: another question (or another first choice, when a plan's
 * lint closes the recommended option) in the same place starts clean.
 */
export function AnswerScope({
  question,
  repo,
  initial,
  origin,
  children,
}: {
  readonly question: Question;
  readonly repo: string | undefined;
  readonly initial: readonly string[];
  readonly origin?: "inbox" | undefined;
  readonly children: ReactNode;
}) {
  const daemon = useDaemonStore();
  return (
    <ScopeProvider
      key={`${question.runId}/${question.id}/${initial.join("\n")}`}
      store={Answer}
      init={{ daemon, question, repo, initial, origin }}
    >
      {children}
    </ScopeProvider>
  );
}

/** What the daemon said of a refused answer, until closed. */
export function AnswerError() {
  const error = useAnswer((s) => s.error);
  const clearError = useAnswer((s) => s.clearError);
  return <Notice text={error} onClose={clearError} />;
}

/** "Reject" or "Other": the chosen option the person's words are the reason for. */
export const reasonFor = (s: { readonly choices: readonly string[] }): string =>
  s.choices.find((c) => needsReason([c])) ?? "this answer";

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
  return (
    <AnswerScope question={q} repo={repo} initial={!q.multiSelect && recommended ? [recommended] : []}>
      <QuickAnswerForm question={q} max={max} onDone={onDone} />
    </AnswerScope>
  );
}

function QuickAnswerForm({
  question: q,
  max,
  onDone,
}: {
  readonly question: Question;
  readonly max?: number | undefined;
  onDone(choices: readonly string[]): void;
}) {
  const api = useAnswerApi();
  return (
    <form
      className="quick-answer"
      data-testid="quick-answer"
      onSubmit={(e) => {
        e.preventDefault();
        void api.getState().send({ onDone });
      }}
    >
      <div className="chips">
        {q.options.slice(0, max ?? q.options.length).map((o) => (
          <QuickChip key={o.label} label={o.label} description={o.description} />
        ))}
      </div>
      <QuickReason multiSelect={q.multiSelect} />
      <SendChosen />
      <AnswerError />
    </form>
  );
}

function QuickChip({
  label,
  description,
}: {
  readonly label: string;
  readonly description?: string | undefined;
}) {
  const pressed = useAnswer((s) => s.choices.includes(label));
  const busy = useAnswer((s) => s.busy);
  const toggle = useAnswer((s) => s.toggle);
  return (
    <Button
      className="option-chip"
      aria-pressed={pressed}
      title={description}
      disabled={busy}
      onClick={() => toggle(label)}
    >
      {label}
    </Button>
  );
}

function QuickReason({ multiSelect }: { readonly multiSelect: boolean }) {
  const reason = useAnswer(reasonOf);
  const none = useAnswer((s) => s.choices.length === 0);
  if (reason) return <QuickReasonField />;
  return multiSelect && none ? <span className="dim">choose one or more</span> : null;
}

function QuickReasonField() {
  const text = useAnswer((s) => s.text);
  const setText = useAnswer((s) => s.setText);
  const forWhat = useAnswer(reasonFor);
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the field appears because the chosen option needs it
      autoFocus
      className="reason"
      aria-label="reason (required)"
      placeholder={`Reason for ${forWhat} (required)`}
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
  );
}

/** The button that sends what is chosen: it draws again when the choice or the readiness changes. */
function SendChosen() {
  const ready = useAnswer(readyOf);
  const chosen = useAnswer(chosenOf);
  return (
    <Button type="submit" variant="primary" disabled={!ready}>
      {chosen !== "" ? chosen : "Choose"} ⏎
    </Button>
  );
}
