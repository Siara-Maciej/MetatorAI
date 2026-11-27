/**
 * The rows of the sidebar's tree, each a component of its own so React Compiler draws again only
 * the rows whose task, thread or fold changed: a task with its panes or its steps by repository,
 * a group's open and finished tasks, a thread with its tasks.
 */

import type { ThreadView } from "../../shared/api/api.ts";
import { Glyph } from "../../shared/components/glyph.tsx";
import { firstLevel, lookOf } from "../../shared/model/look.ts";
import { paneLabel, paneStateOf, panesOfRun } from "../../shared/model/panes.ts";
import { finishedText, isFinished, runLine } from "../../shared/model/runs.ts";
import { subtasksByRepo, taskLine, type WorkTask } from "../../shared/model/tasks.ts";
import { type ThreadGroup, threadLine } from "../../shared/model/threads.ts";
import { navigate } from "../../shared/navigation.ts";
import { Button } from "../../ui/button.tsx";
import type { SidebarCtx } from "./model.ts";
import { Row } from "./row.tsx";

/** A task: its row, and while unfolded its panes (a run of its own) or its steps by repository. */
function TaskRows({ t, ctx }: { readonly t: WorkTask; readonly ctx: SidebarCtx }) {
  const { route, current, fold, expandedNow, runOf, wordOf, stateOf, panesOf, openDecisionOr, onRun } = ctx;
  const headRun = t.head ? runOf(t.head) : undefined;
  const word = wordOf(t);
  const look = lookOf("first", word);
  const open = expandedNow(t);
  const kids =
    t.kind === "run" && headRun && !isFinished(headRun)
      ? panesOfRun(panesOf(headRun.repo), headRun.runId)
      : [];
  const canOpen = t.subtasks.length > 0 || kids.length > 0;
  return (
    <div className="task" data-testid={`side-task-${t.key}`}>
      <div className="task-row">
        {canOpen ? (
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
          glyph={<Glyph kind="first" state={word} />}
          name={t.title}
          sub={t.kind === "run" && headRun ? runLine(headRun) : taskLine(t)}
          word={word}
          tone={look.tone}
          current={t.head?.runId !== undefined && t.head.runId === current}
          title={headRun && isFinished(headRun) ? `${t.title}\n${finishedText(headRun)}` : t.title}
          onClick={() => {
            if (headRun && t.kind === "run") openDecisionOr(headRun, headRun.terminalAsk);
            else if (headRun) onRun(headRun, headRun.terminalAsk);
            else if (t.kind === "system" || t.kind === "parent") navigate({ screen: "board", task: t.key });
          }}
        />
      </div>
      {open && t.kind === "run"
        ? kids.map((p) => {
            // A pane on the first level: it asks (needs you), it works, or nothing (its finer
            // word, idle or exited, is in the run's terminal).
            const st = paneStateOf(p);
            const pw = st === "asks" ? "needs you" : st === "working" ? "working" : undefined;
            return (
              <Row
                key={p.id}
                className="pane-row"
                nested
                glyph={<Glyph kind="first" state={pw} />}
                name={paneLabel(p)}
                word={pw}
                tone={pw ? lookOf("first", pw).tone : "faint"}
                current={headRun?.runId === current && route.screen === "run" && route.pane === p.id}
                title={`${p.id} · ${p.state?.reason ?? ""}`}
                onClick={() => headRun && onRun(headRun, p.id)}
              />
            );
          })
        : null}
      {open && t.kind !== "run"
        ? subtasksByRepo(t).map((g) => (
            <div key={g.repo || "."} className="task-repo">
              <div className="repo-name">{g.repo || "this repository"}</div>
              {g.cards.map((c) => {
                const r = runOf(c);
                const st = r ? firstLevel(stateOf(r)) : firstLevel(c.state);
                return (
                  <Row
                    key={c.key}
                    nested
                    className={c.kind === "step" ? "pending-step" : ""}
                    glyph={<Glyph kind="first" state={st} />}
                    name={c.title}
                    sub={
                      r
                        ? [
                            c.step ? `step ${c.step.at} of ${c.step.of}` : undefined,
                            isFinished(r) ? undefined : r.stage,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : c.waitsFor && c.waitsFor.length > 0
                          ? `not started · waits for ${c.waitsFor.join(", ")}`
                          : "not started · can start"
                    }
                    word={st}
                    tone={lookOf("first", st).tone}
                    current={r !== undefined && r.runId === current}
                    title={c.title}
                    onClick={() => {
                      if (r) openDecisionOr(r, r.terminalAsk);
                      else if (c.systemRunId)
                        navigate({
                          screen: "run",
                          runId: c.systemRunId,
                          tab: "overview",
                        });
                    }}
                  />
                );
              })}
            </div>
          ))
        : null}
    </div>
  );
}

/** A group's tasks: the open ones, then its finished ones behind "Show finished (N)". */
export function GroupTasks({ g, ctx }: { readonly g: ThreadGroup<ThreadView>; readonly ctx: SidebarCtx }) {
  const { expanded, fold } = ctx;
  const finishedKey = `finished:${g.key}`;
  const showFinished = expanded[finishedKey] ?? false;
  return (
    <>
      {g.open.map((t) => (
        <TaskRows key={t.key} t={t} ctx={ctx} />
      ))}
      {g.finished.length > 0 ? (
        <>
          <Button
            className="section finished-toggle"
            aria-expanded={showFinished}
            data-testid="show-finished"
            onClick={() => fold(finishedKey, !showFinished)}
          >
            <Glyph kind="first" state="done" />
            {showFinished ? `Hide finished (${g.finished.length})` : `Show finished (${g.finished.length})`}
          </Button>
          {showFinished ? g.finished.map((t) => <TaskRows key={t.key} t={t} ctx={ctx} />) : null}
        </>
      ) : null}
    </>
  );
}

/** A thread: its row (a click opens its chat), and its tasks under it while unfolded. */
export function ThreadRows({ g, ctx }: { readonly g: ThreadGroup<ThreadView>; readonly ctx: SidebarCtx }) {
  const { route, expanded, fold, onThread, showMenu, shownThread } = ctx;
  const th = g.thread;
  if (!th) return null;
  const closed = th.state === "closed";
  // Open threads are unfolded and closed ones folded, until folded or unfolded by hand.
  const open = expanded[g.key] ?? (shownThread?.id === th.id || !closed);
  const hasTasks = g.open.length + g.finished.length > 0;
  // A closed thread and one without a task have their own look; the rest the first level's.
  const shown = closed ? "closed" : g.word;
  const kind = closed || g.word === "chat" ? "chat" : "first";
  const openMenu = (e: React.MouseEvent) => {
    showMenu(th, e.clientX, e.clientY);
  };
  // In a folder a chat says whose it is: the folder's, or a repository's (ADR-0113).
  const line = [ctx.placeOf(th), threadLine(g)].filter(Boolean).join(" · ");
  return (
    <div className={`thread${closed ? " closed" : ""}`} data-testid={`side-thread-${th.id}`}>
      <div className="task-row thread-row">
        {hasTasks ? (
          <Button
            variant="ghost"
            className="expander"
            aria-expanded={open}
            aria-label={`${open ? "fold" : "unfold"} ${th.title}`}
            onClick={() => fold(g.key, !open)}
          >
            {open ? "▾" : "▸"}
          </Button>
        ) : (
          <span className="expander" />
        )}
        <Row
          className="thread-head"
          glyph={<Glyph kind={kind} state={shown} />}
          name={th.title}
          sub={line || undefined}
          word={shown}
          tone={lookOf(kind, shown).tone}
          current={route.screen === "thread" && route.id === th.id}
          title={th.title}
          onClick={() => onThread(th)}
        />
        <Button
          variant="ghost"
          className="thread-more"
          aria-label={`more for ${th.title}`}
          title="Close or reopen this chat"
          onClick={openMenu}
        >
          ⋯
        </Button>
      </div>
      {open && hasTasks ? <div className="thread-tasks">{<GroupTasks g={g} ctx={ctx} />}</div> : null}
    </div>
  );
}
