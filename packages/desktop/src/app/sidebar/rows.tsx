/**
 * The rows of the sidebar's tree, each a component of its own that takes a key and reads its own
 * entry of the tree (`state.ts`), whether it is current (the route) and whether it is folded: a
 * run's state changing draws only its row, a move draws only the rows that were or become current.
 * A task with its panes or its steps by repository, a group's open and finished tasks, a thread
 * with its tasks, and the narrow version's glyphs.
 */

import { Glyph } from "../../shared/components/glyph.tsx";
import { lookOf } from "../../shared/model/look.ts";
import { navigate } from "../../shared/navigation.ts";
import { Button } from "../../ui/button.tsx";
import { useRouteOf } from "../use-route.ts";
import { openThread, useSideActs } from "./acts.ts";
import { Row } from "./row.tsx";
import { fold, showMenu, useSidebar } from "./state.ts";
import type { PaneRow, StepRow, TaskRow } from "./tree.ts";

/** The run whose page is shown, when it is one of `holds` (so other rows hear nothing of a move). */
const useShownOf = (holds: readonly string[]): string | undefined =>
  useRouteOf((r) => (r.screen === "run" && holds.includes(r.runId) ? r.runId : undefined));

/** A task: its row, and while unfolded its panes (a run of its own) or its steps by repository. */
export function TaskRows({ taskKey }: { readonly taskKey: string }) {
  const t = useSidebar((s) => s.tree.tasks[taskKey]);
  return t ? <TaskBody t={t} /> : null;
}

function TaskBody({ t }: { readonly t: TaskRow }) {
  const acts = useSideActs();
  const shown = useShownOf(t.holds);
  const byHand = useSidebar((s) => s.expanded[t.key]);
  // Unfolded by hand, or because it holds what is shown.
  const open = byHand ?? shown !== undefined;
  const look = lookOf("first", t.word);
  return (
    <div className="task" data-testid={`side-task-${t.key}`}>
      <div className="task-row">
        {t.canOpen ? (
          <Button
            variant="ghost"
            className="expander"
            aria-expanded={open}
            aria-label={`${open ? "fold" : "unfold"} ${t.title}`}
            onClick={() => fold(t.key, !open)}
          >
            {open ? "▾" : "▸"}
          </Button>
        ) : (
          <span className="expander" />
        )}
        <Row
          glyph={<Glyph kind="first" state={t.word} />}
          name={t.title}
          sub={t.sub}
          word={t.word}
          tone={look.tone}
          current={t.cardRunId !== undefined && t.cardRunId === shown}
          title={t.hover}
          onClick={() => {
            if (t.runId && t.kind === "run") acts.openDecisionOr(t.runId, t.repo, t.terminalAsk);
            else if (t.runId) acts.onRun(t.runId, t.repo, t.terminalAsk);
            else if (t.kind === "system" || t.kind === "parent") navigate({ screen: "board", task: t.key });
          }}
        />
      </div>
      {open && t.kind === "run" ? t.panes.map((p) => <PaneRowOf key={p.id} p={p} t={t} />) : null}
      {open && t.kind !== "run"
        ? t.steps.map((g) => (
            <div key={g.repo || "."} className="task-repo">
              <div className="repo-name">{g.repo || "this repository"}</div>
              {g.rows.map((c) => (
                <StepRowOf key={c.key} c={c} current={c.runId !== undefined && c.runId === shown} />
              ))}
            </div>
          ))
        : null}
    </div>
  );
}

/** A pane on the first level: it asks (needs you), it works, or nothing. */
function PaneRowOf({ p, t }: { readonly p: PaneRow; readonly t: TaskRow }) {
  const acts = useSideActs();
  const current = useRouteOf(
    (r) => r.screen === "run" && t.runId !== undefined && r.runId === t.runId && r.pane === p.id,
  );
  return (
    <Row
      className="pane-row"
      nested
      glyph={<Glyph kind="first" state={p.word} />}
      name={p.label}
      word={p.word}
      tone={p.word ? lookOf("first", p.word).tone : "faint"}
      current={current}
      title={p.title}
      onClick={() => {
        if (t.runId) acts.onRun(t.runId, t.repo, p.id);
      }}
    />
  );
}

function StepRowOf({ c, current }: { readonly c: StepRow; readonly current: boolean }) {
  const acts = useSideActs();
  return (
    <Row
      nested
      className={c.pending ? "pending-step" : ""}
      glyph={<Glyph kind="first" state={c.word} />}
      name={c.title}
      sub={c.sub}
      word={c.word}
      tone={lookOf("first", c.word).tone}
      current={current}
      title={c.title}
      onClick={() => {
        if (c.runId) acts.openDecisionOr(c.runId, c.repo, c.terminalAsk);
        else if (c.systemRunId)
          navigate({
            screen: "run",
            runId: c.systemRunId,
            tab: "overview",
          });
      }}
    />
  );
}

/** A group's tasks: the open ones, then its finished ones behind "Show finished (N)". */
export function GroupTasks({ groupKey }: { readonly groupKey: string }) {
  const open = useSidebar((s) => s.tree.groups[groupKey]?.open);
  return (
    <>
      {open?.map((key) => (
        <TaskRows key={key} taskKey={key} />
      ))}
      <FinishedTasks groupKey={groupKey} />
    </>
  );
}

function FinishedTasks({ groupKey }: { readonly groupKey: string }) {
  const finished = useSidebar((s) => s.tree.groups[groupKey]?.finished);
  const finishedKey = `finished:${groupKey}`;
  const showFinished = useSidebar((s) => s.expanded[finishedKey] ?? false);
  if (!finished || finished.length === 0) return null;
  return (
    <>
      <Button
        className="section finished-toggle"
        aria-expanded={showFinished}
        data-testid="show-finished"
        onClick={() => fold(finishedKey, !showFinished)}
      >
        <Glyph kind="first" state="done" />
        {showFinished ? `Hide finished (${finished.length})` : `Show finished (${finished.length})`}
      </Button>
      {showFinished ? finished.map((key) => <TaskRows key={key} taskKey={key} />) : null}
    </>
  );
}

/** A thread: its row (a click opens its chat), and its tasks under it while unfolded. */
export function ThreadRows({ groupKey }: { readonly groupKey: string }) {
  const g = useSidebar((s) => s.tree.groups[groupKey]);
  const shownHere = useSidebar((s) => g?.threadId !== undefined && s.tree.shownThread === g.threadId);
  const byHand = useSidebar((s) => s.expanded[groupKey]);
  const current = useRouteOf(
    (r) => r.screen === "thread" && g?.threadId !== undefined && r.id === g.threadId,
  );
  const threadId = g?.threadId;
  if (!g || threadId === undefined) return null;
  const closed = g.closed;
  // Open threads are unfolded and closed ones folded, until folded or unfolded by hand.
  const open = byHand ?? (shownHere || !closed);
  const hasTasks = g.open.length + g.finished.length > 0;
  // A closed thread and one without a task have their own look; the rest the first level's.
  const shown = closed ? "closed" : g.word;
  const kind = closed || g.word === "chat" ? "chat" : "first";
  return (
    <div className={`thread${closed ? " closed" : ""}`} data-testid={`side-thread-${threadId}`}>
      <div className="task-row thread-row">
        {hasTasks ? (
          <Button
            variant="ghost"
            className="expander"
            aria-expanded={open}
            aria-label={`${open ? "fold" : "unfold"} ${g.title}`}
            onClick={() => fold(groupKey, !open)}
          >
            {open ? "▾" : "▸"}
          </Button>
        ) : (
          <span className="expander" />
        )}
        <Row
          className="thread-head"
          glyph={<Glyph kind={kind} state={shown} />}
          name={g.title}
          sub={g.line || undefined}
          word={shown}
          tone={lookOf(kind, shown).tone}
          current={current}
          title={g.title}
          onClick={() => openThread(threadId)}
        />
        <Button
          variant="ghost"
          className="thread-more"
          aria-label={`more for ${g.title}`}
          title="Close or reopen this chat"
          onClick={(e) => showMenu({ threadId, title: g.title, open: !closed, x: e.clientX, y: e.clientY })}
        >
          ⋯
        </Button>
      </div>
      {open && hasTasks ? <div className="thread-tasks">{<GroupTasks groupKey={groupKey} />}</div> : null}
    </div>
  );
}

/** The narrow version's glyph of an open thread, named in full on hover. */
export function ThreadIcon({ groupKey }: { readonly groupKey: string }) {
  const g = useSidebar((s) => s.tree.groups[groupKey]);
  const current = useRouteOf(
    (r) => r.screen === "thread" && g?.threadId !== undefined && r.id === g.threadId,
  );
  const threadId = g?.threadId;
  if (!g || threadId === undefined) return null;
  const kind = g.word === "chat" ? "chat" : "first";
  return (
    <Icon
      glyph={<Glyph kind={kind} state={g.word} />}
      title={`${g.title} · ${g.word}`}
      onClick={() => openThread(threadId)}
      current={current}
    />
  );
}

/** The narrow version's glyph of a task without a chat. */
export function TaskIcon({ taskKey }: { readonly taskKey: string }) {
  const t = useSidebar((s) => s.tree.tasks[taskKey]);
  const shown = useShownOf(t?.holds ?? NO_RUNS);
  const acts = useSideActs();
  if (!t) return null;
  return (
    <Icon
      glyph={<Glyph kind="first" state={t.word} />}
      title={`${t.title} · ${t.word}`}
      onClick={() => {
        if (t.runId) acts.openDecisionOr(t.runId, t.repo);
      }}
      current={shown !== undefined}
    />
  );
}

const NO_RUNS: readonly string[] = [];

/** One glyph of the narrow version, named on hover. */
export function Icon({
  glyph,
  title,
  onClick,
  current = false,
}: {
  readonly glyph: React.ReactNode;
  readonly title: string;
  onClick(): void;
  readonly current?: boolean;
}) {
  return (
    <Button
      className="nicon"
      title={title}
      aria-label={title}
      aria-current={current ? "true" : undefined}
      onClick={onClick}
    >
      {glyph}
    </Button>
  );
}
