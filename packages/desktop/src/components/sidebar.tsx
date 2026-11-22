/**
 * The sidebar: one hierarchy, thread → its tasks → repositories → steps (round 16). A thread is
 * one topic with its chat terminal; its row reads one word (its most urgent task's, or `chat`
 * when it has none) and how many tasks it holds; a click opens its chat. Under it, its tasks: one
 * row per task (a system task, a run with child runs, a standalone run), with one state word,
 * its progress and how many of its steps need the person; what needs the person sorts first. A
 * task expands to its own tree: its steps and child runs by repository (pending steps with what
 * they wait for); a standalone run expands to its panes. Tasks no thread holds are in "Without a
 * chat"; closed threads wait under "Closed (N)", folded. Home shows the decisions one at a time;
 * the sidebar only counts them. Every row reads one of the first level's four words
 * (`firstLevel`); no ids, hosts or ages. Finished tasks are hidden behind "Show finished (N)" in
 * each group. The places are at the bottom: Board, Terminals, Backlog, and Settings, which holds
 * the System and the Reviews; then "+ New chat" and the form.
 */
import type { ReactNode } from "react";
import { useState } from "react";
import type { ThreadView } from "../api.ts";
import { type BoardCard, boardCards } from "../board.ts";
import { useDaemon } from "../daemon.tsx";
import {
  decisionKey,
  type FirstLevel,
  finishedText,
  firstLevel,
  isFinished,
  lookOf,
  type NeedRow,
  paneLabel,
  paneNeedsYou,
  paneStateOf,
  panesOfRun,
  plural,
  type Route,
  type Run,
  routeHash,
  runLine,
  runWithPanes,
  sameRepo,
} from "../model.ts";
import { byAttentionFirst, subtasksByRepo, taskLine, taskState, type WorkTask, workTasks } from "../tasks.ts";
import { heldThread, type ThreadGroup, threadLine, threadPane, threadTree } from "../threads.ts";
import { ContextMenu } from "./context-menu.tsx";
import { Glyph } from "./glyph.tsx";
import { moveInList } from "./list-keys.ts";

/** The places that are not a run, in the order of the sidebar's bottom. */
const PLACES: readonly {
  readonly route: Route;
  readonly label: string;
  readonly glyph: string;
  /** The screens the place holds (Settings: the System and the Reviews too). */
  readonly holds: readonly Route["screen"][];
}[] = [
  { route: { screen: "board" }, label: "Board", glyph: "▥", holds: ["board"] },
  { route: { screen: "grid" }, label: "Terminals", glyph: "▦", holds: ["grid"] },
  { route: { screen: "backlog" }, label: "Backlog", glyph: "☷", holds: ["backlog"] },
  { route: { screen: "settings" }, label: "Settings", glyph: "⚙", holds: ["settings", "overview", "mrs"] },
];

/** One row of the sidebar: glyph, name, the state's word, one dim line. */
export function Row({
  glyph,
  name,
  sub,
  word,
  tone,
  current,
  nested = false,
  className = "",
  ...rest
}: {
  readonly glyph: ReactNode;
  readonly name: ReactNode;
  readonly sub?: ReactNode;
  readonly word?: string | undefined;
  readonly tone?: string | undefined;
  readonly current?: boolean | undefined;
  readonly nested?: boolean;
  readonly className?: string;
  readonly title?: string | undefined;
  readonly "data-testid"?: string | undefined;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={`row${nested ? " nested" : ""} ${className}`}
      aria-current={current ? "true" : undefined}
      {...rest}
    >
      {glyph}
      <span className="text">
        <span className="title">{name}</span>
        {sub ? <span className="sub">{sub}</span> : null}
      </span>
      {word ? <span className={`word kind ${tone ?? ""}`}>{word}</span> : null}
    </button>
  );
}

export function Sidebar({
  route,
  needs,
  onRun,
  onInbox,
  onNew,
  onForm,
  onThread,
  onCloseThread,
  onReopenThread,
}: {
  readonly route: Route;
  /** Everything that needs the person (model.ts `needsQueue`). */
  readonly needs: readonly NeedRow[];
  onRun(run: Run, pane?: string): void;
  onInbox(): void;
  /** "+ New chat": a new thread with its chat terminal. */
  onNew(): void;
  /** The form: workflow, autonomy, host and worktree chosen by hand. */
  onForm(): void;
  /** Opens a thread: its chat terminal as the main view. */
  onThread(thread: ThreadView): void;
  onCloseThread(thread: ThreadView): void;
  onReopenThread(thread: ThreadView): void;
}) {
  const { runs, panes, panesOf, down, unreadable, systemPlans, inbox, threads, paneAsks } = useDaemon();
  // A run that asks on a card opens that decision on Home, exactly that one.
  const decisionOf = (r: Run) => inbox.find((i) => i.runId === r.runId && sameRepo(i.repo, r.repo));
  const openDecisionOr = (r: Run, pane?: string) => {
    const d = decisionOf(r);
    if (d) window.location.hash = routeHash({ screen: "inbox", pick: decisionKey(d) });
    else onRun(r, pane);
  };
  // What is folded or unfolded by hand, by key: a task, a thread, a group's finished tasks.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showClosed, setShowClosed] = useState(false);
  const [menu, setMenu] = useState<{ thread: ThreadView; x: number; y: number }>();
  const current = route.screen === "run" ? route.runId : undefined;
  const stateOf = (r: Run) =>
    runWithPanes(
      r,
      panesOfRun(panesOf(r.repo), r.runId).map((p) => paneStateOf(p)),
    );
  // The work as parent tasks (tasks.ts), from the same cards the Board shows.
  const tasks = byAttentionFirst(
    workTasks(boardCards({ runs, issues: [], plans: systemPlans, now: Date.now() }), systemPlans),
  );
  const runOf = (c: BoardCard) =>
    c.runId ? runs.find((r) => r.runId === c.runId && sameRepo(r.repo, c.repo)) : undefined;
  /** A task's word as its row says it: a run of its own reads its panes too (a conductor at work is working). */
  const wordOf = (t: WorkTask): FirstLevel => {
    const headRun = t.head ? runOf(t.head) : undefined;
    return t.kind === "run" && headRun && !isFinished(headRun) ? firstLevel(stateOf(headRun)) : taskState(t);
  };
  const chatOf = (th: ThreadView) => threadPane(th, panes);
  const tree = threadTree({
    threads,
    tasks,
    wordOf,
    chatAsks: (th) => {
      const p = chatOf(th);
      return p !== undefined && (paneNeedsYou(p, paneAsks) || paneStateOf(p) === "asks");
    },
  });
  // The thread that holds what is shown is unfolded, whatever was folded before.
  const shownThread = heldThread(threads, tasks, {
    thread: route.screen === "thread" ? route.id : undefined,
    runId: current,
  });
  const holds = (t: WorkTask) =>
    current !== undefined && (t.head?.runId === current || t.subtasks.some((c) => c.runId === current));
  const expandedNow = (t: WorkTask) => expanded[t.key] ?? holds(t);
  const taskRows = (t: WorkTask) => {
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
      <div key={t.key} className="task" data-testid={`side-task-${t.key}`}>
        <div className="task-row">
          {canOpen ? (
            <button
              type="button"
              className="ghost expander"
              aria-expanded={open}
              aria-label={`${open ? "fold" : "unfold"} ${t.title}`}
              onClick={() => setExpanded({ ...expanded, [t.key]: !open })}
            >
              {open ? "▾" : "▸"}
            </button>
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
              else if (t.kind === "system" || t.kind === "parent")
                window.location.hash = routeHash({ screen: "board", task: t.key });
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
                          window.location.hash = routeHash({
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
  };
  /** A group's tasks: the open ones, then its finished ones behind "Show finished (N)". */
  const groupTasks = (g: ThreadGroup<ThreadView>) => {
    const finishedKey = `finished:${g.key}`;
    const showFinished = expanded[finishedKey] ?? false;
    return (
      <>
        {g.open.map((t) => taskRows(t))}
        {g.finished.length > 0 ? (
          <>
            <button
              type="button"
              className="section finished-toggle"
              aria-expanded={showFinished}
              data-testid="show-finished"
              onClick={() => setExpanded({ ...expanded, [finishedKey]: !showFinished })}
            >
              <Glyph kind="first" state="done" />
              {showFinished ? `Hide finished (${g.finished.length})` : `Show finished (${g.finished.length})`}
            </button>
            {showFinished ? g.finished.map((t) => taskRows(t)) : null}
          </>
        ) : null}
      </>
    );
  };
  /** A thread: its row (a click opens its chat), and its tasks under it while unfolded. */
  const threadRows = (g: ThreadGroup<ThreadView>) => {
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
      setMenu({ thread: th, x: e.clientX, y: e.clientY });
    };
    return (
      <div key={g.key} className={`thread${closed ? " closed" : ""}`} data-testid={`side-thread-${th.id}`}>
        <div className="task-row thread-row">
          {hasTasks ? (
            <button
              type="button"
              className="ghost expander"
              aria-expanded={open}
              aria-label={`${open ? "fold" : "unfold"} ${th.title}`}
              onClick={() => setExpanded({ ...expanded, [g.key]: !open })}
            >
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span className="expander" />
          )}
          <Row
            className="thread-head"
            glyph={<Glyph kind={kind} state={shown} />}
            name={th.title}
            sub={threadLine(g) || undefined}
            word={shown}
            tone={lookOf(kind, shown).tone}
            current={route.screen === "thread" && route.id === th.id}
            title={th.title}
            onClick={() => onThread(th)}
          />
          <button
            type="button"
            className="ghost thread-more"
            aria-label={`more for ${th.title}`}
            title="Close or reopen this chat"
            onClick={openMenu}
          >
            ⋯
          </button>
        </div>
        {open && hasTasks ? <div className="thread-tasks">{groupTasks(g)}</div> : null}
      </div>
    );
  };
  const openCount = tree.threads.length;
  return (
    <aside className="sessions" aria-label="runs" onKeyDown={(e) => moveInList(e, ".row")}>
      <div className="list">
        {down ? (
          <div className="section">No daemon: nothing to list</div>
        ) : (
          <>
            <button type="button" className="section needs-head" data-testid="needs-count" onClick={onInbox}>
              <Glyph kind="first" state={needs.length > 0 ? "needs you" : undefined} />
              Needs you · {needs.length}
            </button>
            <section className="threads" aria-label="chats">
              {tree.threads.map((g) => threadRows(g))}
              {openCount === 0 && !tree.without ? (
                <div className="quiet">{tree.closed.length > 0 ? "No open chat." : "No chat yet."}</div>
              ) : null}
            </section>
            {tree.without ? (
              <section className="tasks without-chat" aria-label="without a chat" data-testid="without-chat">
                <div className="section">Without a chat · {tree.without.open.length}</div>
                {groupTasks(tree.without)}
              </section>
            ) : null}
            {tree.closed.length > 0 ? (
              <section className="threads closed-threads" aria-label="closed chats">
                <button
                  type="button"
                  className="section"
                  aria-expanded={showClosed}
                  data-testid="show-closed"
                  onClick={() => setShowClosed(!showClosed)}
                >
                  <span className="g faint" aria-hidden="true">
                    {showClosed ? "▾" : "▸"}
                  </span>
                  Closed ({tree.closed.length})
                </button>
                {showClosed ? tree.closed.map((g) => threadRows(g)) : null}
              </section>
            ) : null}
          </>
        )}
      </div>
      {menu ? (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          label={`chat ${menu.thread.title}`}
          onClose={() => setMenu(undefined)}
          items={[
            { label: "Open chat", onSelect: () => onThread(menu.thread) },
            menu.thread.state === "open"
              ? { label: "Close chat", separator: true, onSelect: () => onCloseThread(menu.thread) }
              : { label: "Reopen chat", separator: true, onSelect: () => onReopenThread(menu.thread) },
          ]}
        />
      ) : null}
      {unreadable.length > 0 ? (
        <details className="unreadable" data-testid="unreadable">
          <summary className="amber">{plural(unreadable.length, "run")} cannot be read</summary>
          <ul>
            {unreadable.map((u) => (
              <li key={`${u.repo ?? ""}:${u.runId}`}>
                <span className="mono">{u.runId}</span>
                {u.repo ? ` · ${u.repo}` : ""}: {u.message}. Restore <code>{u.file}</code>, or delete the
                run's directory.
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <nav className="places" aria-label="places">
        {PLACES.map((p) => (
          <a
            key={p.label}
            className="row place"
            href={routeHash(p.route)}
            aria-current={p.holds.includes(route.screen) ? "page" : undefined}
          >
            <span className="g faint" aria-hidden="true">
              {p.glyph}
            </span>
            <span className="text">
              <span className="title">{p.label}</span>
            </span>
          </a>
        ))}
      </nav>
      <div className="new-run">
        <button
          type="button"
          className="primary"
          title="A new chat: one topic with the conversation agent; it starts the runs (key n)"
          disabled={down}
          onClick={onNew}
        >
          + New chat
        </button>
        <button
          type="button"
          aria-label="New run from the form"
          title="The form: workflow, autonomy, host, worktree"
          disabled={down}
          onClick={onForm}
        >
          Form…
        </button>
      </div>
    </aside>
  );
}
