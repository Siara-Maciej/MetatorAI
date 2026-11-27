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
 * each group. The places are at the bottom: Board, Terminals, Backlog, Reviews (round 18: used
 * daily), and Settings, which holds the System; then "+ New chat" and the form.
 */

import { useState } from "react";
import { useOpenRun } from "../../features/runs/open-run.ts";
import { useNewChat, useThreadAct } from "../../features/threads/chat-actions.ts";
import type { ThreadView } from "../../shared/api/api.ts";
import { Glyph } from "../../shared/components/glyph.tsx";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { type BoardCard, boardCards } from "../../shared/model/board.ts";
import { plural } from "../../shared/model/format.ts";
import { type FirstLevel, firstLevel } from "../../shared/model/look.ts";
import { decisionKey, type NeedRow, paneNeedsYou } from "../../shared/model/needs.ts";
import { paneStateOf, panesOfRun } from "../../shared/model/panes.ts";
import { chatPlaceLabel, chatPlaces, sameRepo } from "../../shared/model/places.ts";
import { type Route, routeHash } from "../../shared/model/route.ts";
import { isFinished, type Run, runWithPanes } from "../../shared/model/runs.ts";
import { byAttentionFirst, taskState, type WorkTask, workTasks } from "../../shared/model/tasks.ts";
import { heldThread, threadPane, threadTree } from "../../shared/model/threads.ts";
import { navigate } from "../../shared/navigation.ts";
import { openNewRun } from "../../shared/overlays.ts";
import { Button } from "../../ui/button.tsx";
import { ContextMenu } from "../../ui/context-menu.tsx";
import { moveInList } from "../../ui/list-keys.ts";
import type { SidebarCtx } from "./model.ts";
import { GroupTasks, ThreadRows } from "./rows.tsx";

/** The places that are not a run, in the order of the sidebar's bottom. */
const PLACES: readonly {
  readonly route: Route;
  readonly label: string;
  readonly glyph: string;
  /** The screens the place holds (Settings: the System too). */
  readonly holds: readonly Route["screen"][];
}[] = [
  { route: { screen: "board" }, label: "Board", glyph: "▥", holds: ["board"] },
  { route: { screen: "grid" }, label: "Terminals", glyph: "▦", holds: ["grid"] },
  { route: { screen: "backlog" }, label: "Backlog", glyph: "☷", holds: ["backlog"] },
  { route: { screen: "reviews" }, label: "Reviews", glyph: "◇", holds: ["reviews"] },
  { route: { screen: "settings" }, label: "Settings", glyph: "⚙", holds: ["settings", "overview"] },
];

export function Sidebar({
  route,
  needs,
  narrow = false,
  onNarrow,
}: {
  /** Folded to its narrow version (round 22): a column of glyphs, each named on hover. */
  readonly narrow?: boolean | undefined;
  onNarrow?: ((narrow: boolean) => void) | undefined;
  readonly route: Route;
  /** Everything that needs the person (model.ts `needsQueue`). */
  readonly needs: readonly NeedRow[];
}) {
  const openRun = useOpenRun();
  // An escalated run's card is on Home; any other run opens its page.
  const onRun = (r: Run, pane?: string) =>
    r.status === "escalated"
      ? navigate({ screen: "inbox", pick: `escalated:${r.repo ?? ""}:${r.runId}` })
      : openRun(r.runId, false, pane);
  const onInbox = () => navigate({ screen: "inbox" });
  const newChat = useNewChat();
  const onNew = () => void newChat();
  const onForm = openNewRun;
  const onThread = (t: ThreadView) => navigate({ screen: "thread", id: t.id });
  const threadAct = useThreadAct();
  const onCloseThread = (t: ThreadView) => void threadAct(t, "close");
  const onReopenThread = (t: ThreadView) => void threadAct(t, "reopen");
  const { runs, panes, panesOf, down, unreadable, systemPlans, inbox, threads, paneAsks, repos } = useDaemon(
    "repos",
    "runs",
    "panes",
    "panesOf",
    "down",
    "unreadable",
    "systemPlans",
    "inbox",
    "threads",
    "paneAsks",
  );
  // A run that asks on a card opens that decision on Home, exactly that one.
  const decisionOf = (r: Run) => inbox.find((i) => i.runId === r.runId && sameRepo(i.repo, r.repo));
  const openDecisionOr = (r: Run, pane?: string) => {
    const d = decisionOf(r);
    if (d) navigate({ screen: "inbox", pick: decisionKey(d) });
    else onRun(r, pane);
  };
  // What is folded or unfolded by hand, by key: a task, a thread, a group's finished tasks.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showClosed, setShowClosed] = useState(false);
  const [menu, setMenu] = useState<{ thread: ThreadView; x: number; y: number }>();
  // In a folder: where a new chat opens, the folder first (ADR-0113).
  const places = chatPlaces(repos);
  const [placeMenu, setPlaceMenu] = useState<{ x: number; y: number }>();
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
  const ctx: SidebarCtx = {
    route,
    current,
    expanded,
    fold: (key, open) => setExpanded({ ...expanded, [key]: open }),
    expandedNow,
    runOf,
    wordOf,
    stateOf,
    panesOf,
    openDecisionOr,
    onRun,
    onThread,
    showMenu: (thread, x, y) => setMenu({ thread, x, y }),
    shownThread,
    placeOf: (t) => chatPlaceLabel(repos, t.repo),
  };
  const openCount = tree.threads.length;
  const fold = onNarrow ? (
    <Button
      variant="ghost"
      className="side-fold"
      data-testid="side-fold"
      aria-label={narrow ? "Expand the sidebar" : "Collapse the sidebar"}
      title={narrow ? "Expand the sidebar" : "Collapse the sidebar to its icons"}
      aria-expanded={!narrow}
      onClick={() => onNarrow(!narrow)}
    >
      {narrow ? "»" : "«"}
    </Button>
  ) : null;
  if (narrow) {
    // The narrow version: what needs you, a glyph per open chat and per task without one, the
    // places, a new chat; each named in full on hover.
    const icon = (
      key: string,
      glyph: React.ReactNode,
      title: string,
      onClick: () => void,
      current = false,
    ) => (
      <Button
        key={key}
        className="nicon"
        title={title}
        aria-label={title}
        aria-current={current ? "true" : undefined}
        onClick={onClick}
      >
        {glyph}
      </Button>
    );
    const loose = tree.without?.open ?? [];
    return (
      <aside className="sessions narrow" aria-label="runs" data-testid="sidebar-narrow">
        {fold}
        <div className="list">
          {down
            ? null
            : [
                icon(
                  "needs",
                  <>
                    <Glyph kind="first" state={needs.length > 0 ? "needs you" : undefined} />
                    {needs.length > 0 ? <span className="ncount">{needs.length}</span> : null}
                  </>,
                  `Needs you · ${needs.length}`,
                  onInbox,
                ),
                <hr key="sep1" />,
                ...tree.threads.map((g) => {
                  const th = g.thread;
                  if (!th) return null;
                  const kind = g.word === "chat" ? "chat" : "first";
                  return icon(
                    g.key,
                    <Glyph kind={kind} state={g.word} />,
                    `${th.title} · ${g.word}`,
                    () => onThread(th),
                    route.screen === "thread" && route.id === th.id,
                  );
                }),
                ...loose.map((t) =>
                  icon(
                    t.key,
                    <Glyph kind="first" state={wordOf(t)} />,
                    `${t.title} · ${wordOf(t)}`,
                    () => {
                      const headRun = t.head ? runOf(t.head) : undefined;
                      if (headRun) openDecisionOr(headRun);
                    },
                    holds(t),
                  ),
                ),
              ]}
        </div>
        <nav className="places" aria-label="places">
          {PLACES.map((p) => (
            <a
              key={p.label}
              className="nicon place"
              href={routeHash(p.route)}
              title={p.label}
              aria-label={p.label}
              aria-current={p.holds.includes(route.screen) ? "page" : undefined}
            >
              {p.glyph}
            </a>
          ))}
        </nav>
        <div className="new-run">
          <Button
            variant="primary"
            title="A new chat (key n)"
            aria-label="New chat"
            disabled={down}
            onClick={onNew}
          >
            +
          </Button>
        </div>
      </aside>
    );
  }
  return (
    <aside className="sessions" aria-label="runs" onKeyDown={(e) => moveInList(e, ".row")}>
      <div className="list">
        {down ? (
          <div className="section">No daemon: nothing to list</div>
        ) : (
          <>
            <div className="side-head">
              <Button className="section needs-head" data-testid="needs-count" onClick={onInbox}>
                <Glyph kind="first" state={needs.length > 0 ? "needs you" : undefined} />
                Needs you · {needs.length}
              </Button>
              {fold}
            </div>
            <section className="threads" aria-label="chats">
              {tree.threads.map((g) => (
                <ThreadRows key={g.key} g={g} ctx={ctx} />
              ))}
              {openCount === 0 && !tree.without ? (
                <div className="quiet">{tree.closed.length > 0 ? "No open chat." : "No chat yet."}</div>
              ) : null}
            </section>
            {tree.without ? (
              <section className="tasks without-chat" aria-label="without a chat" data-testid="without-chat">
                <div className="section">Without a chat · {tree.without.open.length}</div>
                <GroupTasks g={tree.without} ctx={ctx} />
              </section>
            ) : null}
            {tree.closed.length > 0 ? (
              <section className="threads closed-threads" aria-label="closed chats">
                <Button
                  className="section"
                  aria-expanded={showClosed}
                  data-testid="show-closed"
                  onClick={() => setShowClosed(!showClosed)}
                >
                  <span className="g faint" aria-hidden="true">
                    {showClosed ? "▾" : "▸"}
                  </span>
                  Closed ({tree.closed.length})
                </Button>
                {showClosed ? tree.closed.map((g) => <ThreadRows key={g.key} g={g} ctx={ctx} />) : null}
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
      {placeMenu ? (
        <ContextMenu
          at={placeMenu}
          label="where the new chat opens"
          onClose={() => setPlaceMenu(undefined)}
          items={places.map((p, i) => ({
            label: `New chat in ${p.label}`,
            separator: i === 1,
            onSelect: () => void newChat(undefined, p.name),
          }))}
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
        <Button
          variant="primary"
          title="A new chat: one topic with the conversation agent; it starts the runs (key n)"
          disabled={down}
          onClick={onNew}
        >
          + New chat
        </Button>
        {places.length > 0 ? (
          <Button
            aria-label="New chat in a repository"
            title="Where the new chat opens: the folder, or one repository"
            data-testid="new-chat-where"
            disabled={down}
            onClick={(e) => {
              const at = e.currentTarget.getBoundingClientRect();
              setPlaceMenu({ x: at.left, y: at.top });
            }}
          >
            ▾
          </Button>
        ) : null}
        <Button
          aria-label="New run from the form"
          title="The form: workflow, autonomy, host, worktree"
          disabled={down}
          onClick={onForm}
        >
          Form…
        </Button>
      </div>
    </aside>
  );
}
