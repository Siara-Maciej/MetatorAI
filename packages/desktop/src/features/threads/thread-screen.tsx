/**
 * A thread (round 16): its chat terminal as the main view, under a bar with its title, its one
 * word and Close or Reopen; below the terminal, its tasks as tiles that open their pages. A
 * closed thread keeps its tasks (they go on) and offers Reopen; nothing of it is deleted.
 *
 * The screen only lays its parts out (ADR-0113): each part reads its one fact of the thread, its
 * chat's pane or its tasks (`thread-state.ts`), so a run that changes draws the word and the tasks
 * again, not the chat's terminal.
 */

import { useStore } from "zustand";
import { Glyph } from "../../shared/components/glyph.tsx";
import { NotFound } from "../../shared/components/not-found.tsx";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import { useDaemon, useDaemonStore } from "../../shared/daemon/daemon.tsx";
import { useFound } from "../../shared/hooks.ts";
import { threadsHave } from "../../shared/model/found.ts";
import { lookOf } from "../../shared/model/look.ts";
import { paneNeedsYou } from "../../shared/model/needs.ts";
import { paneStateOf } from "../../shared/model/panes.ts";
import { chatPlaceLabel } from "../../shared/model/places.ts";
import { routeHash } from "../../shared/model/route.ts";
import { taskLine, taskState } from "../../shared/model/tasks.ts";
import { threadLine, threadPane, threadTree } from "../../shared/model/threads.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { PaneFrame } from "../terminals/pane-frame.tsx";
import { Thread, useThreadActs, useThreadFact, useThreadTasks } from "./thread-state.ts";

export function ThreadScreen({ id }: { readonly id: string }) {
  const daemon = useDaemonStore();
  const present = useStore(daemon, (d) => d.threads.some((t) => t.id === id));
  const { client } = useDaemon("client");
  // A chat just made is not in the window's list yet: missing only on the daemon's word.
  const lookup = useFound(`thread:${id}`, present, client.threads, (v) => threadsHave(v, id));
  if (!present)
    return lookup === "missing" ? (
      <NotFound what="chat" id={id} />
    ) : (
      <div className="empty">Opening chat {id}…</div>
    );
  return (
    <ScopeProvider key={id} store={Thread} init={{ daemon, id }}>
      <div className="thread-screen" data-testid={`thread-${id}`}>
        <header className="thread-bar">
          <ThreadHead />
          <span className="spacer" />
          <CloseOrReopen />
        </header>
        <ThreadChat />
        <ThreadTasks />
      </div>
    </ScopeProvider>
  );
}

const threadOf = (d: Daemon, id: string) => d.threads.find((t) => t.id === id);
/** The thread's chat as the layout has it: running, paused, or ended with what ended it. */
const paneOf = (d: Daemon, id: string) => {
  const t = threadOf(d, id);
  return t ? threadPane(t, d.panes) : undefined;
};
/** Its chat asks the person. */
const asksOf = (d: Daemon, id: string) => {
  const pane = paneOf(d, id);
  return pane !== undefined && (paneNeedsYou(pane, d.paneAsks) || paneStateOf(pane) === "asks");
};

/** The thread with its tasks, as the sidebar groups it (`threadTree`): its word, its line, its tasks. */
function useThreadGroup() {
  const thread = useThreadFact(threadOf);
  const asks = useThreadFact(asksOf);
  const tasks = useThreadTasks();
  if (!thread) return undefined;
  const closed = thread.state === "closed";
  const group = threadTree({ threads: [thread], tasks, chatAsks: () => asks });
  return { closed, g: (closed ? group.closed : group.threads)[0] };
}

/** The glyph, the title, the one word and the line of the bar. */
export function ThreadHead() {
  const title = useThreadFact((d, id) => threadOf(d, id)?.title);
  // In a folder: whose chat this is, the folder's or a repository's.
  const place = useThreadFact((d, id) => chatPlaceLabel(d.repos, threadOf(d, id)?.repo));
  const group = useThreadGroup();
  if (!group) return null;
  const { closed, g } = group;
  const word = closed ? "closed" : (g?.word ?? "chat");
  const kind = closed || word === "chat" ? "chat" : "first";
  return (
    <>
      <Glyph kind={kind} state={word} />
      <h1>{title}</h1>
      <span className={`word ${lookOf(kind, word).tone ?? ""}`}>{word}</span>
      {place ? (
        <span className="faint" data-testid="thread-place">
          · {place}
        </span>
      ) : null}
      {g && threadLine(g) ? <span className="faint">· {threadLine(g)}</span> : null}
    </>
  );
}

function CloseOrReopen() {
  const closed = useThreadFact((d, id) => threadOf(d, id)?.state === "closed");
  const { close, reopen } = useThreadActs();
  return closed ? (
    <Button variant="primary" onClick={() => void reopen()}>
      Reopen chat
    </Button>
  ) : (
    <Button onClick={() => void close()} title="Ends its chat terminal; its tasks go on">
      Close chat
    </Button>
  );
}

/** The chat's terminal: it draws again only when its pane, whether it asks, or the thread's state changed. */
export function ThreadChat() {
  const closed = useThreadFact((d, id) => threadOf(d, id)?.state === "closed");
  const live = useThreadFact((d, id) => threadOf(d, id)?.chat?.status === "live");
  const pane = useThreadFact(paneOf);
  const asks = useThreadFact(asksOf);
  const { close, reopen } = useThreadActs();
  return (
    <div className="thread-chat">
      {closed ? (
        <div className="thread-quiet" data-testid="thread-closed">
          <p>This chat is closed. Its tasks go on; reopen it to talk again.</p>
        </div>
      ) : pane ? (
        <PaneFrame
          pane={pane}
          state={paneStateOf(pane)}
          repo={pane.repo}
          focused
          framed={false}
          labels={false}
          symbols={false}
          mine={false}
          canType={!pane.runId}
          scrollback={5000}
          asking={false}
          copying={false}
          lastOfTab={false}
          needsYou={asks}
          onFocus={() => undefined}
          onMenu={() => undefined}
          onZoom={() => undefined}
          onBlockedKey={() => undefined}
          onReady={() => undefined}
          // The daemon continues a thread's chat: its paused pane, its kept session, or a new one told to carry on.
          onRetry={() => void reopen()}
          onContinue={() => void reopen()}
          onClose={() => void close()}
        />
      ) : live ? (
        // The daemon opened it; the layout shows it on its next read.
        <div className="thread-quiet">
          <p>Opening its chat…</p>
        </div>
      ) : (
        <div className="thread-quiet" data-testid="thread-stopped">
          <p>Its chat stopped. Continue it to go on where it was.</p>
          <Button variant="primary" onClick={() => void reopen()}>
            Continue chat
          </Button>
        </div>
      )}
    </div>
  );
}

/** Its tasks as tiles that open their pages. */
export function ThreadTasks() {
  const group = useThreadGroup();
  const mine = [...(group?.g?.open ?? []), ...(group?.g?.finished ?? [])];
  if (mine.length === 0) return null;
  return (
    <ul className="thread-tiles" aria-label="tasks of this chat" data-testid="thread-tasks">
      {mine.map((t) => {
        const w = taskState(t);
        const href = t.head?.runId
          ? routeHash({ screen: "run", runId: t.head.runId, tab: "overview" })
          : routeHash({ screen: "board", task: t.key });
        return (
          <li key={t.key}>
            <a className="tile" href={href}>
              <span className="tile-head">
                <Glyph kind="first" state={w} />
                <span className="title">{t.title}</span>
                <span className={`word ${lookOf("first", w).tone ?? ""}`}>{w}</span>
              </span>
              <span className="sub">{taskLine(t)}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
