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
 *
 * It only lays its parts out (ADR-0113): `SideFeed` works the tree out of the daemon's state and
 * publishes it (`state.ts`), and each row reads its own entry, so a run's change draws its row.
 */

import { useLayoutEffect } from "react";
import { useNeeds } from "../../features/inbox/use-needs.ts";
import { useNewChat, useThreadAct } from "../../features/threads/chat-actions.ts";
import { Glyph } from "../../shared/components/glyph.tsx";
import { useDaemon, useDaemonStore } from "../../shared/daemon/daemon.tsx";
import { plural } from "../../shared/model/format.ts";
import { type Route, routeHash } from "../../shared/model/route.ts";
import { navigate } from "../../shared/navigation.ts";
import { openNewRun } from "../../shared/overlays.ts";
import { Button } from "../../ui/button.tsx";
import { ContextMenu } from "../../ui/context-menu.tsx";
import { moveInList } from "../../ui/list-keys.ts";
import { useRouteOf } from "../use-route.ts";
import { GroupTasks, Icon, TaskIcon, ThreadIcon, ThreadRows } from "./rows.tsx";
import { closeMenu, publishTree, toggleClosed, useSidebar } from "./state.ts";
import { sideTree, threadById } from "./tree.ts";

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

const onInbox = () => navigate({ screen: "inbox" });

export function Sidebar({
  narrow = false,
  onNarrow,
}: {
  /** Folded to its narrow version (round 22): a column of glyphs, each named on hover. */
  readonly narrow?: boolean | undefined;
  onNarrow?: ((narrow: boolean) => void) | undefined;
}) {
  const fold = onNarrow ? <FoldButton narrow={narrow} onNarrow={onNarrow} /> : null;
  return (
    <>
      <SideFeed />
      {narrow ? <NarrowSidebar fold={fold} /> : <WideSidebar fold={fold} />}
    </>
  );
}

/** Works the tree out of the daemon's state and the place shown, and publishes it; draws nothing. */
function SideFeed() {
  const { runs, panes, panesOf, systemPlans, threads, paneAsks } = useDaemon(
    "runs",
    "panes",
    "panesOf",
    "systemPlans",
    "threads",
    "paneAsks",
  );
  const thread = useRouteOf((r) => (r.screen === "thread" ? r.id : undefined));
  const runId = useRouteOf((r) => (r.screen === "run" ? r.runId : undefined));
  const tree = sideTree({
    runs,
    panes,
    panesOf,
    systemPlans,
    threads,
    paneAsks,
    shown: { thread, runId },
    now: Date.now(),
  });
  useLayoutEffect(() => publishTree(tree));
  return null;
}

function FoldButton({ narrow, onNarrow }: { readonly narrow: boolean; onNarrow(narrow: boolean): void }) {
  return (
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
  );
}

/** The narrow version: what needs you, a glyph per open chat and per task without one, the places, a new chat. */
function NarrowSidebar({ fold }: { readonly fold: React.ReactNode }) {
  const { down } = useDaemon("down");
  const threads = useSidebar((s) => s.tree.threads);
  const loose = useSidebar((s) => (s.tree.without ? s.tree.groups[s.tree.without]?.open : undefined));
  return (
    <aside className="sessions narrow" aria-label="runs" data-testid="sidebar-narrow">
      {fold}
      <div className="list">
        {down
          ? null
          : [
              <NeedsIcon key="needs" />,
              <hr key="sep1" />,
              ...threads.map((key) => <ThreadIcon key={key} groupKey={key} />),
              ...(loose ?? []).map((key) => <TaskIcon key={key} taskKey={key} />),
            ]}
      </div>
      <nav className="places" aria-label="places">
        {PLACES.map((p) => (
          <PlaceLink key={p.label} place={p} narrow />
        ))}
      </nav>
      <div className="new-run">
        <NewChatButton narrow down={down} />
      </div>
    </aside>
  );
}

function NeedsIcon() {
  const needs = useNeeds().length;
  return (
    <Icon
      glyph={
        <>
          <Glyph kind="first" state={needs > 0 ? "needs you" : undefined} />
          {needs > 0 ? <span className="ncount">{needs}</span> : null}
        </>
      }
      title={`Needs you · ${needs}`}
      onClick={onInbox}
    />
  );
}

function WideSidebar({ fold }: { readonly fold: React.ReactNode }) {
  const { down } = useDaemon("down");
  return (
    <aside className="sessions" aria-label="runs" onKeyDown={(e) => moveInList(e, ".row")}>
      <div className="list">
        {down ? (
          <div className="section">No daemon: nothing to list</div>
        ) : (
          <>
            <div className="side-head">
              <NeedsHead />
              {fold}
            </div>
            <OpenThreads />
            <WithoutChat />
            <ClosedThreads />
          </>
        )}
      </div>
      <ThreadMenu />
      <Unreadable />
      <nav className="places" aria-label="places">
        {PLACES.map((p) => (
          <PlaceLink key={p.label} place={p} narrow={false} />
        ))}
      </nav>
      <div className="new-run">
        <NewChatButton narrow={false} down={down} />
        <Button
          aria-label="New run from the form"
          title="The form: workflow, autonomy, host, worktree"
          disabled={down}
          onClick={openNewRun}
        >
          Form…
        </Button>
      </div>
    </aside>
  );
}

function NeedsHead() {
  const needs = useNeeds().length;
  return (
    <Button className="section needs-head" data-testid="needs-count" onClick={onInbox}>
      <Glyph kind="first" state={needs > 0 ? "needs you" : undefined} />
      Needs you · {needs}
    </Button>
  );
}

function OpenThreads() {
  const threads = useSidebar((s) => s.tree.threads);
  const quiet = useSidebar((s) =>
    s.tree.threads.length === 0 && !s.tree.without
      ? s.tree.closed.length > 0
        ? "No open chat."
        : "No chat yet."
      : undefined,
  );
  return (
    <section className="threads" aria-label="chats">
      {threads.map((key) => (
        <ThreadRows key={key} groupKey={key} />
      ))}
      {quiet ? <div className="quiet">{quiet}</div> : null}
    </section>
  );
}

function WithoutChat() {
  const without = useSidebar((s) => s.tree.without);
  const count = useSidebar((s) => (s.tree.without ? (s.tree.groups[s.tree.without]?.open.length ?? 0) : 0));
  return without ? (
    <section className="tasks without-chat" aria-label="without a chat" data-testid="without-chat">
      <div className="section">Without a chat · {count}</div>
      <GroupTasks groupKey={without} />
    </section>
  ) : null;
}

function ClosedThreads() {
  const closed = useSidebar((s) => s.tree.closed);
  const showClosed = useSidebar((s) => s.showClosed);
  return closed.length > 0 ? (
    <section className="threads closed-threads" aria-label="closed chats">
      <Button className="section" aria-expanded={showClosed} data-testid="show-closed" onClick={toggleClosed}>
        <span className="g faint" aria-hidden="true">
          {showClosed ? "▾" : "▸"}
        </span>
        Closed ({closed.length})
      </Button>
      {showClosed ? closed.map((key) => <ThreadRows key={key} groupKey={key} />) : null}
    </section>
  ) : null;
}

/** A chat's ⋯ menu: open it, close or reopen it. */
function ThreadMenu() {
  const menu = useSidebar((s) => s.menu);
  const daemon = useDaemonStore();
  const threadAct = useThreadAct();
  if (!menu) return null;
  const act = (how: "close" | "reopen") => {
    const thread = threadById(daemon.getState().threads, menu.threadId);
    if (thread) void threadAct(thread, how);
  };
  return (
    <ContextMenu
      at={{ x: menu.x, y: menu.y }}
      label={`chat ${menu.title}`}
      onClose={closeMenu}
      items={[
        { label: "Open chat", onSelect: () => navigate({ screen: "thread", id: menu.threadId }) },
        menu.open
          ? { label: "Close chat", separator: true, onSelect: () => act("close") }
          : { label: "Reopen chat", separator: true, onSelect: () => act("reopen") },
      ]}
    />
  );
}

/** Runs whose record cannot be read: they are in no list, so the panel says where they are. */
function Unreadable() {
  const { unreadable } = useDaemon("unreadable");
  return unreadable.length > 0 ? (
    <details className="unreadable" data-testid="unreadable">
      <summary className="amber">{plural(unreadable.length, "run")} cannot be read</summary>
      <ul>
        {unreadable.map((u) => (
          <li key={`${u.repo ?? ""}:${u.runId}`}>
            <span className="mono">{u.runId}</span>
            {u.repo ? ` · ${u.repo}` : ""}: {u.message}. Restore <code>{u.file}</code>, or delete the run's
            directory.
          </li>
        ))}
      </ul>
    </details>
  ) : null;
}

function PlaceLink({
  place: p,
  narrow,
}: {
  readonly place: (typeof PLACES)[number];
  readonly narrow: boolean;
}) {
  const here = useRouteOf((r) => p.holds.includes(r.screen));
  return narrow ? (
    <a
      className="nicon place"
      href={routeHash(p.route)}
      title={p.label}
      aria-label={p.label}
      aria-current={here ? "page" : undefined}
    >
      {p.glyph}
    </a>
  ) : (
    <a className="row place" href={routeHash(p.route)} aria-current={here ? "page" : undefined}>
      <span className="g faint" aria-hidden="true">
        {p.glyph}
      </span>
      <span className="text">
        <span className="title">{p.label}</span>
      </span>
    </a>
  );
}

function NewChatButton({ narrow, down }: { readonly narrow: boolean; readonly down: boolean }) {
  const newChat = useNewChat();
  const onNew = () => void newChat();
  return narrow ? (
    <Button
      variant="primary"
      title="A new chat (key n)"
      aria-label="New chat"
      disabled={down}
      onClick={onNew}
    >
      +
    </Button>
  ) : (
    <Button
      variant="primary"
      title="A new chat: one topic with the conversation agent; it starts the runs (key n)"
      disabled={down}
      onClick={onNew}
    >
      + New chat
    </Button>
  );
}
