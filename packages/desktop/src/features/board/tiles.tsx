/**
 * The Board's tiles: a task (its word, progress and what needs the person) and a card (a run, a pending step, a backlog item), each in its state's look.
 */
import type { KeyboardEvent } from "react";
import { type BoardCard, cardLine, cardState, partOfLine } from "../../shared/model/board.ts";
import { type FirstLevel, lookOf } from "../../shared/model/look.ts";
import { taskLine, taskState, type WorkTask } from "../../shared/model/tasks.ts";
import { Button } from "../../ui/button.tsx";

/** The word and look of a card: one of the first level's four (`firstLevel`). */
function stateLook(state: FirstLevel): { glyph: string; tone: string; word: string } {
  const look = lookOf("first", state);
  return { glyph: look.glyph, tone: look.tone ?? "faint", word: state };
}
/**
 * Space opens a card as it presses a button (Enter is the Board's, with the arrows); Space on the
 * card's own Start a run presses that button, not the card.
 */
function opensOnSpace(e: KeyboardEvent<HTMLDivElement>): boolean {
  if (e.key !== " " || e.target !== e.currentTarget) return false;
  e.preventDefault();
  return true;
}
export function TaskTile({
  task: t,
  col,
  row,
  onOpen,
  onStart,
  onDrag,
}: {
  readonly task: WorkTask;
  readonly col: number;
  readonly row: number;
  onOpen(t: WorkTask): void;
  onStart(c: BoardCard): void;
  onDrag(): void;
}) {
  const look = stateLook(taskState(t));
  const opens = t.kind === "system" || t.kind === "parent";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card holds a button of its own (Start a run)
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDrag}
      className={`board-card task${t.needsYou > 0 ? " needs" : ""}${t.escalated > 0 ? " escalated" : ""}${t.state === "aborted" ? " aborted" : ""}`}
      data-card={t.key}
      data-col={col}
      data-row={row}
      data-testid={`task-${t.key}`}
      title={opens ? `${t.title}: open its board` : t.title}
      aria-label={`${t.title}, ${look.word}`}
      onClick={() => onOpen(t)}
      onKeyDown={(e) => {
        if (opensOnSpace(e)) onOpen(t);
      }}
    >
      <div className="card-top">
        <span className={`card-state ${look.tone}`}>
          {look.glyph} {look.word}
        </span>
      </div>
      <div className="card-title">{t.title}</div>
      <div className="card-line faint">{taskLine(t, false)}</div>
      {t.progress ? (
        <div className="card-part" data-testid="task-progress">
          {t.progress.done} of {t.progress.of} steps done{opens ? " · open its board ›" : ""}
        </div>
      ) : null}
      {t.kind === "issue" && t.head ? (
        <Button
          className="card-action"
          onClick={(e) => {
            e.stopPropagation();
            if (t.head) onStart(t.head);
          }}
        >
          Start a run
        </Button>
      ) : null}
    </div>
  );
}
export function CardTile({
  card: c,
  why,
  col,
  row,
  onOpen,
  onStart,
  onDrag,
}: {
  readonly card: BoardCard;
  /** Why a blocked run stands still. */
  readonly why?: string | undefined;
  readonly col: number;
  readonly row: number;
  onOpen(c: BoardCard): void;
  onStart(c: BoardCard): void;
  onDrag(): void;
}) {
  const look = stateLook(cardState(c));
  const part = partOfLine(c);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card holds a button of its own (Start a run)
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDrag}
      className={`board-card${c.needsYou ? " needs" : ""}${c.escalated ? " escalated" : ""}${c.state === "aborted" ? " aborted" : ""}${c.kind === "step" ? " pending" : ""}`}
      data-card={c.key}
      data-col={col}
      data-row={row}
      data-testid={`card-${c.kind}-${c.runId ?? c.issueId ?? c.key}`}
      title={c.title}
      aria-label={`${c.title}, ${look.word}`}
      onClick={() => onOpen(c)}
      onKeyDown={(e) => {
        if (opensOnSpace(e)) onOpen(c);
      }}
    >
      <div className="card-top">
        <span className={`card-state ${look.tone}`}>
          {look.glyph} {look.word}
        </span>
      </div>
      <div className="card-title">{c.title}</div>
      <div className="card-line faint">{cardLine(c)}</div>
      {part ? <div className="card-part">{part}</div> : null}
      {c.waitsFor && c.waitsFor.length > 0 ? (
        <div className="card-waits faint">waits for: {c.waitsFor.join(", ")}</div>
      ) : null}
      {why ? <div className="card-waits red">{why}</div> : null}
      {c.kind === "issue" ? (
        <Button
          className="card-action"
          onClick={(e) => {
            e.stopPropagation();
            onStart(c);
          }}
        >
          Start a run
        </Button>
      ) : null}
    </div>
  );
}
