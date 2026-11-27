/**
 * The card of a pane's question on Home (ADR-0091): a pane without a run (the intake chat) asks,
 * its host for leave to run a command or its agent in words. The card shows the prompt, the pane
 * and its repository, and the choices; a choice is sent with `POST /panes/:pane/answer`, and the
 * daemon types it into the pane (a menu's number, the agent's words). Attach goes to the pane.
 *
 * What the card keeps is its PaneAsk store (ADR-0113, `state.ts`): the choice, the words, the
 * message unfolded; each part reads only its own value.
 */

import type { PaneAsk } from "../../shared/api/api.ts";
import { CommandText, commandOf } from "../../shared/components/command-text.tsx";
import { useDaemonStore } from "../../shared/daemon/daemon.tsx";
import { askWhy, consentOf } from "../../shared/model/stage1.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { PaneAskStore, usePaneAsk, usePaneAskApi } from "./state.ts";

/**
 * An agent's whole message (its question in words, with its options as it wrote them): folded to
 * one line; a click (or Enter) shows it all, as it reads in the terminal.
 */
function MessageText({ text }: { readonly text: string }) {
  const open = usePaneAsk((s) => s.open);
  const toggleOpen = usePaneAsk((s) => s.toggleOpen);
  const first = text.split("\n")[0] ?? "";
  return (
    <div className="pane-message">
      <Button
        variant="ghost"
        className="cmd-short"
        aria-expanded={open}
        data-testid="message-short"
        title={open ? "hide the whole message" : "show the whole message"}
        onClick={toggleOpen}
      >
        {open ? "Hide the message" : `The whole message: ${first}${text.includes("\n") ? " …" : ""}`}
      </Button>
      {open ? (
        <pre className="cmd-full" data-testid="message-full">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

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
  const daemon = useDaemonStore();
  const q = ask.question;
  // A commit, push, merge or rebase the guard lets through only with the person's consent.
  const consent = q.source === "permission" ? consentOf(q) : undefined;
  // The guard's own reason, when the host shows one (a commit that holds debug changes).
  const why = q.source === "permission" ? askWhy(q) : undefined;
  return (
    <ScopeProvider store={PaneAskStore} init={{ daemon }}>
      <article className="card pane-ask" aria-label="pane question" data-testid={`pane-ask-${ask.paneId}`}>
        <h1>
          {q.source === "permission" || commandOf(q) ? (
            <CommandText prompt={q.prompt} command={commandOf(q)} />
          ) : (
            q.prompt
          )}
        </h1>
        <div className="muted" data-testid="pane-asker">
          {q.source === "agent" ? `${q.agent}` : `${ask.host}`} asks in the {ask.label} pane
          {ask.repo ? ` of ${ask.repo}` : ""}
          {ask.runId ? ` (run ${ask.runId})` : ", before any run"}: answer here and it is typed there.
        </div>
        {why ? (
          <div className="consent" data-testid="ask-why">
            {why}
          </div>
        ) : null}
        {consent ? (
          <div className="consent amber" data-testid="consent">
            {consent.text}
          </div>
        ) : null}
        {q.text ? <MessageText text={q.text} /> : null}
        <div className="decide-bar">
          <fieldset className="options">
            <legend className="dim">options</legend>
            {q.options.map((o) => (
              <PaneOption
                key={o.label}
                name={`pane-ask-${q.id}`}
                label={o.label}
                description={o.description}
              />
            ))}
          </fieldset>
          <OtherWords />
          <div className="actions">
            <SendChoice ask={ask} onAnswered={onAnswered} onOpenPane={onOpenPane} />
            <Button onClick={() => onOpenPane(ask)}>Open the pane</Button>
          </div>
        </div>
        <PaneAskNotice />
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
    </ScopeProvider>
  );
}

/** One option: it hears only whether it is the one chosen. */
function PaneOption({
  name,
  label,
  description,
}: {
  readonly name: string;
  readonly label: string;
  readonly description?: string | undefined;
}) {
  const checked = usePaneAsk((s) => s.choice === label);
  const choose = usePaneAsk((s) => s.choose);
  return (
    <label className="option">
      <input type="radio" name={name} checked={checked} onChange={() => choose(label)} />
      <span className="label">{label}</span>
      {description ? <span className="faint"> {description}</span> : null}
    </label>
  );
}

/** Other chosen: the person's own words, typed into the pane. */
export function OtherWords() {
  const other = usePaneAsk((s) => s.choice === "Other");
  return other ? <OtherWordsField /> : null;
}

function OtherWordsField() {
  const words = usePaneAsk((s) => s.words);
  const setWords = usePaneAsk((s) => s.setWords);
  return (
    <label className="reason">
      <span className="amber">your words</span>
      <textarea aria-label="your words" rows={2} value={words} onChange={(e) => setWords(e.target.value)} />
    </label>
  );
}

function SendChoice({
  ask,
  onAnswered,
  onOpenPane,
}: {
  readonly ask: PaneAsk;
  onAnswered(choices: readonly string[]): void;
  onOpenPane(ask: PaneAsk): void;
}) {
  const blocked = usePaneAsk((s) => !s.choice || s.busy || (s.choice === "Other" && s.words.trim() === ""));
  const api = usePaneAskApi();
  return (
    <Button
      variant="primary"
      disabled={blocked}
      onClick={() => void api.getState().send(ask, onAnswered, onOpenPane)}
    >
      Send
    </Button>
  );
}

function PaneAskNotice() {
  const notice = usePaneAsk((s) => s.notice);
  const closeNotice = usePaneAsk((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
}
