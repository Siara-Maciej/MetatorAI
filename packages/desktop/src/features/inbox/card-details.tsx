/**
 * The Details part of a decision card (DecisionCard): folded under the card's face.
 */

import { useStore } from "zustand";
import type { InboxItem } from "../../shared/api/api.ts";
import { Chip } from "../../shared/components/chips.tsx";
import { FoldList } from "../../shared/components/fold-list.tsx";
import { duration } from "../../shared/model/format.ts";
import { type hostPromptOf, type paneOfQuestion, questionKind } from "../../shared/model/needs.ts";
import { Button } from "../../ui/button.tsx";
import { readyOf, reasonOf, type SendOptions, useAnswer, useAnswerApi } from "./answer-state.ts";
import { answerCommand, goalShown } from "./model.ts";

/**
 * The card's Details, folded: who asks and where, the run's goal, what was done so far and its
 * artifacts, the command that answers the same way, and the ways to the run's session or change.
 */
export function CardDetails({
  item,
  askPane,
  host,
  groupText,
  done,
  onOpenChanges,
  onOpenSession,
}: {
  readonly item: InboxItem;
  /** The pane of a question read from a terminal. */
  readonly askPane: ReturnType<typeof paneOfQuestion>;
  /** A host's prompt in a pane, as its question. */
  readonly host: ReturnType<typeof hostPromptOf>;
  /** "step N of M" of a run that is a step of a system plan. */
  groupText(g: { readonly parent: string; readonly step: number; readonly of: number }): string;
  /** What a send does after the daemon answered (the card's callbacks). */
  readonly done: Pick<SendOptions, "onDone" | "onRefused">;
  onOpenChanges(runId: string): void;
  onOpenSession(runId: string): void;
}) {
  const view = useAnswer((s) => s.view);
  const q = item.question;
  const card = q.card;
  return (
    <details className="card-details" data-testid="card-details">
      <summary>Details</summary>
      <div className="ctx">
        <span className="mono">{q.id}</span>
        <span>{questionKind(q)}</span>
        <span>{item.stage}</span>
        {item.repo ? <span>{item.repo}</span> : null}
        <span className="mono">{q.runId}</span>
        {q.agent ? <span>{q.agent}</span> : null}
        {askPane ? <span className="mono">pane {askPane}</span> : null}
        {host ? <span className="mono">pane {host.pane}</span> : null}
      </div>
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
        {card?.group ? <Chip tone="blue">{groupText(card.group)}</Chip> : null}
      </div>
      {card && goalShown(q.prompt, card.task) ? (
        <section>
          <h3>Goal</h3>
          <div>{card.task}</div>
        </section>
      ) : null}
      {card?.soFar?.length ? (
        <section>
          <h3>Since you left</h3>
          <FoldList lines={card.soFar} label="since you left" />
        </section>
      ) : null}
      {card && (card.done.length > 0 || card.artifacts.length > 0) ? (
        <section>
          <h3>Proposal and evidence</h3>
          {card.done.length > 0 ? <div className="muted">done: {card.done.join(" → ")}</div> : null}
          {card.artifacts.length > 0 ? (
            <div className="muted">
              see:{" "}
              {card.artifacts.map((name, i) => (
                <span key={name}>
                  {i > 0 ? " · " : null}
                  <Button
                    variant="ghost"
                    className="link mono"
                    onClick={() => view(name)}
                    title={`read ${name}`}
                  >
                    {name}
                  </Button>
                </span>
              ))}
            </div>
          ) : null}
          {card.evidence?.length ? <FoldList lines={card.evidence} keep={3} label="evidence" /> : null}
        </section>
      ) : null}
      <section>
        <h3>What each answer does</h3>
        <ul className="consequences" data-testid="consequences">
          {q.options.map((o) => (
            <li key={o.label}>
              <strong>{o.label}</strong>
              {o.description ? <span className="muted"> · {o.description}</span> : null}
              {card?.consequences?.[o.label] ? (
                <span className="cons"> → {card.consequences[o.label]}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <NoteField done={done} />
      <div className="actions">
        <Button onClick={() => onOpenChanges(q.runId)}>Changes</Button>
        <Button onClick={() => onOpenSession(q.runId)}>Open run · o</Button>
      </div>
      <WritesCommand question={q} />
    </details>
  );
}

/** The optional note, when the chosen options promise no reason: typing draws only this field. */
export function NoteField({ done }: { readonly done: Pick<SendOptions, "onDone" | "onRefused"> }) {
  const reason = useAnswer(reasonOf);
  return reason ? null : <NoteInput done={done} />;
}

function NoteInput({ done }: { readonly done: Pick<SendOptions, "onDone" | "onRefused"> }) {
  const text = useAnswer((s) => s.text);
  const setText = useAnswer((s) => s.setText);
  const api = useAnswerApi();
  return (
    <label className="reason">
      <span className="dim">Note (optional)</span>
      <input
        aria-label="note"
        placeholder="a note for the log"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && readyOf(api.getState())) void api.getState().send(done);
        }}
      />
    </label>
  );
}

/** The command that answers the same way: it follows what is chosen and written. */
export function WritesCommand({ question }: { readonly question: InboxItem["question"] }) {
  const choices = useAnswer((s) => s.choices);
  const text = useAnswer((s) => s.text);
  const me = useStore(
    useAnswer((s) => s.daemon),
    (d) => d.me,
  );
  return <div className="footer-cmd mono">writes: {answerCommand(question, choices, me, text)}</div>;
}
