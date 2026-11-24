/**
 * Home: one decision at a time. A big card with the question or the plan and its actions; above
 * it, how many wait and the next and previous one (also `j` and `k`). Everything else about the
 * decision (its ids, evidence, "since you left", what each answer does, the command it writes)
 * is folded under the card's Details. With nothing to decide: the tasks in short with their
 * state, the runs nothing drives, and "Describe a task"; with no run at all, only the latter.
 */

import { useState } from "react";
import type { InboxItem } from "../../shared/api/api.ts";
import { Glyph } from "../../shared/components/glyph.tsx";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { useAction, useTasks } from "../../shared/hooks.ts";
import { lookOf } from "../../shared/model/look.ts";
import {
  decisionKey,
  escalatedKey,
  idleRuns,
  isPaneAsk,
  isTerminalAsk,
  type NeedRow,
  paneAskOf,
  stepNeed,
} from "../../shared/model/needs.ts";
import { routeHash } from "../../shared/model/route.ts";
import { openRuns } from "../../shared/model/runs.ts";
import { byAttentionFirst, taskLine, taskState } from "../../shared/model/tasks.ts";
import { threadTitleOf } from "../../shared/model/threads.ts";
import { navigate } from "../../shared/navigation.ts";
import { Notice } from "../../ui/notice.tsx";
import { isReviewCard, reviewCardKey } from "../reviews/model.ts";
import { ReviewCard } from "../reviews/review-card.tsx";
import { DebugChanges } from "../runs/debug-changes.tsx";
import { StartRun } from "../runs/start-run.tsx";
import { DecisionCard } from "./decision-card.tsx";
import { EscalatedCard } from "./escalated-card.tsx";
import { isFirstRun, quietHeading, quietInboxText, taskNeed } from "./model.ts";
import { PaneAskCard } from "./pane-ask-card.tsx";

export function InboxScreen({
  needs,
  picked,
  onPick,
  onAnswered,
  onRefused,
  onOpenRun,
  onOpenChanges,
  onOverview,
  onStart,
  onForm,
}: {
  /** Everything that needs the person, in the queue's order. */
  readonly needs: readonly NeedRow[];
  /** The decision to show: the picked one, else the first. */
  readonly picked: NeedRow | undefined;
  /** The next or the previous decision was chosen. */
  onPick(key: string): void;
  /** An answer went through, or an escalated run was resumed or closed. */
  onAnswered(choices?: readonly string[], item?: InboxItem): void;
  /** A card's answer was refused: the app says it where it stays (the card may close). */
  onRefused?: ((message: string) => void) | undefined;
  onOpenRun(runId: string, pane?: string): void;
  onOpenChanges(runId: string): void;
  onOverview(runId: string): void;
  /** Starts a run from what the person wrote: the agent gets it as its first line. */
  onStart(task: string): void;
  onForm(): void;
}) {
  const { inbox, runs, paneAsks, reviewCards } = useDaemon("inbox", "runs", "paneAsks", "reviewCards");
  const item = picked ? inbox.find((i) => decisionKey(i) === picked.key) : undefined;
  // A pane without a run that asks (the intake chat): its own card, answered into the pane.
  const paneAsk = picked && isPaneAsk(picked) ? paneAskOf(paneAsks, picked.key) : undefined;
  const stopped =
    picked?.kind === "escalated"
      ? runs.find((r) => r.status === "escalated" && escalatedKey(r) === picked.key)
      : undefined;
  // A review's card (round 18): asked to review, new commits or replies, a new review, approve.
  const review =
    picked && isReviewCard(picked) ? reviewCards.find((c) => reviewCardKey(c) === picked.key) : undefined;
  const at = picked ? needs.findIndex((n) => n.key === picked.key) : -1;
  const move = (step: 1 | -1) => {
    const next = stepNeed(needs, picked?.key, step);
    if (next) onPick(next.key);
  };
  // Debug changes the daemon counts: an entry on Home while there are some (round 13).
  const debug = (
    <div className="home-debug">
      <DebugChanges />
    </div>
  );
  if (needs.length === 0)
    return (
      <div className="home">
        {debug}
        {isFirstRun(runs, needs) ? (
          <FirstRun onStart={onStart} onForm={onForm} />
        ) : (
          <QuietHome onOpenRun={onOpenRun} onStart={onStart} onForm={onForm} />
        )}
      </div>
    );
  return (
    <div className="home">
      {debug}
      <nav className="queue" data-testid="queue" aria-label="decisions that wait">
        <strong>{needs.length} waiting</strong>
        <span className="faint">
          {" "}
          · {at + 1} of {needs.length}
        </span>
        <span className="spacer" />
        <button type="button" disabled={needs.length < 2} onClick={() => move(-1)} title="key k">
          ‹ Previous
        </button>
        <button type="button" disabled={needs.length < 2} onClick={() => move(1)} title="key j">
          Next ›
        </button>
      </nav>
      {item ? (
        <DecisionCard
          key={picked?.key}
          item={item}
          onAnswered={(choices) => onAnswered(choices, item)}
          onRefused={onRefused}
          onOpenSession={onOverview}
          onOpenChanges={onOpenChanges}
        />
      ) : paneAsk ? (
        <PaneAskCard
          key={picked?.key}
          ask={paneAsk}
          onAnswered={(choices) => onAnswered(choices)}
          onOpenPane={(a) => {
            navigate({ screen: "grid", pane: a.paneId });
          }}
        />
      ) : stopped ? (
        <div data-testid={`escalated-${stopped.runId}`}>
          <EscalatedCard
            key={picked?.key}
            run={stopped}
            onDone={() => onAnswered()}
            onBriefing={onOverview}
            onOpenChanges={onOpenChanges}
          />
        </div>
      ) : review ? (
        <ReviewCard key={picked?.key} card={review} onDone={() => onAnswered()} />
      ) : picked && isTerminalAsk(picked) ? (
        <article className="card terminal-ask" data-testid={`terminal-ask-${picked.runId}`}>
          <h1>{picked.title}</h1>
          {picked.sub ? <div className="dim">{picked.sub}</div> : null}
          <p className="muted">
            The agent asks in its terminal: there is no card to answer from. Open the run, take the keyboard
            and answer there.
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => onOpenRun(picked.runId, picked.pane)}>
              Open the run
            </button>
          </div>
        </article>
      ) : (
        <div className="empty">Reading the decision…</div>
      )}
    </div>
  );
}

/** Nothing was ever started here: say what to do, or fill the form. */
function FirstRun({ onStart, onForm }: { onStart(task: string): void; onForm(): void }) {
  const [task, setTask] = useState("");
  return (
    <form
      className="first-run"
      data-testid="first-run"
      onSubmit={(e) => {
        e.preventDefault();
        if (task.trim() !== "") onStart(task.trim());
      }}
    >
      <h1>Describe a task</h1>
      <p className="muted">
        Say what to do in a sentence or two. The agent opens in a terminal, asks what is unclear and starts
        the run; every decision it needs from you comes here.
      </p>
      <textarea
        aria-label="Describe a task"
        rows={4}
        placeholder="for example: add a 10% discount to invoices over 1000, with a test"
        value={task}
        onChange={(e) => setTask(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && task.trim() !== "") onStart(task.trim());
        }}
      />
      <div className="actions">
        <button type="submit" className="primary" disabled={task.trim() === ""}>
          Start
        </button>
        <button type="button" onClick={onForm}>
          Use the form
        </button>
        <span className="faint">
          <kbd>ctrl+↵</kbd> starts
        </span>
      </div>
    </form>
  );
}

/**
 * Nothing waits for a decision: the tasks in short with their state, the runs nothing drives
 * with the way to start each, and "Describe a task".
 */
function QuietHome({
  onOpenRun,
  onStart,
  onForm,
}: {
  onOpenRun(runId: string, pane?: string): void;
  onStart(task: string): void;
  onForm(): void;
}) {
  const { runs, panes, threads } = useDaemon("runs", "panes", "threads");
  const tasks = byAttentionFirst(useTasks()).filter((t) => t.column !== "done");
  const action = useAction();
  const open = openRuns(runs);
  const idle = idleRuns(open, panes);
  // A blocked task without a question still waits for the person to look: Home never says "nothing" then.
  const blocked = tasks.filter((t) => taskState(t) === "blocked");
  return (
    <div className="quiet-home" data-testid="inbox-zero">
      <h2>{quietHeading(idle.length, blocked.length)}</h2>
      <p className="muted">{quietInboxText(open.length, idle.length, blocked.length)}</p>
      {idle.length > 0 ? (
        <ul className="idle-runs">
          {idle.map((r) => (
            <li key={`${r.repo ?? ""}/${r.runId}`}>
              <button type="button" className="ghost link" onClick={() => onOpenRun(r.runId)}>
                {r.task}
              </button>{" "}
              <span className="faint">{r.repo ? `${r.repo} · ` : ""}nothing drives it</span>
              <StartRun run={r} action={action} compact />
            </li>
          ))}
        </ul>
      ) : null}
      <Notice {...action.notice} />
      {tasks.length > 0 ? (
        <ul className="home-tasks" aria-label="tasks" data-testid="home-tasks">
          {tasks.map((t) => {
            const word = taskState(t);
            // The chat a task was started in, dim before its name (round 16).
            const chat = threadTitleOf(threads, t);
            const href = t.head?.runId
              ? routeHash({ screen: "run", runId: t.head.runId, tab: "overview" })
              : routeHash({ screen: "board", task: t.key });
            return (
              <li key={t.key}>
                <Glyph kind="first" state={word} />{" "}
                {chat ? <span className="thread-of">{chat} · </span> : null}
                <a href={href}>{t.title}</a> <span className={lookOf("first", word).tone}>{word}</span>
                <span className="faint"> · {taskLine(t)}</span>
                {word === "blocked" ? (
                  <span className="need" data-testid={`need-${t.key}`}>
                    {" "}
                    · {taskNeed(runs.find((r) => r.runId === t.head?.runId))}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <FirstRun onStart={onStart} onForm={onForm} />
    </div>
  );
}
