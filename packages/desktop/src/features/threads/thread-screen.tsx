/**
 * A thread (round 16): its chat terminal as the main view, under a bar with its title, its one
 * word and Close or Reopen; below the terminal, its tasks as tiles that open their pages. A
 * closed thread keeps its tasks (they go on) and offers Reopen; nothing of it is deleted.
 */

import type { ThreadView } from "../../shared/api/api.ts";
import { Glyph } from "../../shared/components/glyph.tsx";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { useTasks } from "../../shared/hooks.ts";
import { lookOf } from "../../shared/model/look.ts";
import { paneNeedsYou } from "../../shared/model/needs.ts";
import { paneStateOf } from "../../shared/model/panes.ts";
import { routeHash } from "../../shared/model/route.ts";
import { byAttentionFirst, taskLine, taskState } from "../../shared/model/tasks.ts";
import { threadLine, threadPane, threadTree } from "../../shared/model/threads.ts";
import { Button } from "../../ui/button.tsx";
import { PaneFrame } from "../terminals/pane-frame.tsx";

export function ThreadScreen({
  id,
  onClose,
  onReopen,
}: {
  readonly id: string;
  onClose(thread: ThreadView): void;
  onReopen(thread: ThreadView): void;
}) {
  const { panes, paneAsks, threads } = useDaemon("panes", "paneAsks", "threads");
  const tasks = byAttentionFirst(useTasks());
  const thread = threads.find((t) => t.id === id);
  if (!thread) return <div className="empty">No chat {id} here: it may still be on its way.</div>;
  // Its chat as the layout has it: running, paused, or ended with what ended it (Retry continues it).
  const pane = threadPane(thread, panes);
  const closed = thread.state === "closed";
  const asks = pane !== undefined && (paneNeedsYou(pane, paneAsks) || paneStateOf(pane) === "asks");
  const group = threadTree({ threads: [thread], tasks, chatAsks: () => asks });
  const g = (closed ? group.closed : group.threads)[0];
  const word = closed ? "closed" : (g?.word ?? "chat");
  const kind = closed || word === "chat" ? "chat" : "first";
  const mine = [...(g?.open ?? []), ...(g?.finished ?? [])];
  return (
    <div className="thread-screen" data-testid={`thread-${thread.id}`}>
      <header className="thread-bar">
        <Glyph kind={kind} state={word} />
        <h1>{thread.title}</h1>
        <span className={`word ${lookOf(kind, word).tone ?? ""}`}>{word}</span>
        {g && threadLine(g) ? <span className="faint">· {threadLine(g)}</span> : null}
        <span className="spacer" />
        {closed ? (
          <Button variant="primary" onClick={() => onReopen(thread)}>
            Reopen chat
          </Button>
        ) : (
          <Button onClick={() => onClose(thread)} title="Ends its chat terminal; its tasks go on">
            Close chat
          </Button>
        )}
      </header>
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
            onRetry={() => onReopen(thread)}
            onContinue={() => onReopen(thread)}
            onClose={() => onClose(thread)}
          />
        ) : thread.chat?.status === "live" ? (
          // The daemon opened it; the layout shows it on its next read.
          <div className="thread-quiet">
            <p>Opening its chat…</p>
          </div>
        ) : (
          <div className="thread-quiet" data-testid="thread-stopped">
            <p>Its chat stopped. Continue it to go on where it was.</p>
            <Button variant="primary" onClick={() => onReopen(thread)}>
              Continue chat
            </Button>
          </div>
        )}
      </div>
      {mine.length > 0 ? (
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
      ) : null}
    </div>
  );
}
