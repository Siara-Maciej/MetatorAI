/**
 * A terminal on one of the daemon's PTYs (screen 2, screen 7): xterm.js over `/ws/pty/<run>` (a
 * run's conductor pane) or `/ws/pane/<pane>` (any pane, R4). Everyone reads; keystrokes go through
 * only while the person is attached (the daemon refuses the rest and says so).
 */
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { wsUrl } from "../api.ts";
import { useDaemon } from "../daemon.tsx";

export interface TerminalStatus {
  readonly alive?: boolean | undefined;
  readonly exitCode?: number | undefined;
  readonly refused?: string | undefined;
}

/** What copy mode (S6) does on a terminal: search its scrollback, copy the selection, focus it. */
export interface TerminalHandle {
  findNext(query: string): boolean;
  findPrevious(query: string): boolean;
  /** The selected text, copied to the clipboard when the browser allows; the text either way. */
  copySelection(): string;
  clearSearch(): void;
  focus(): void;
  scrollToBottom(): void;
}

/** A run's conductor pane (the daemon opens it when none is live). */
export function RunTerminal({
  runId,
  repo,
  canType,
  onStatus,
}: {
  readonly runId: string;
  readonly repo?: string | undefined;
  readonly canType: boolean;
  onStatus?: ((s: TerminalStatus) => void) | undefined;
}) {
  return (
    <SocketTerminal
      path={`/ws/pty/${encodeURIComponent(runId)}`}
      testId={`terminal-${runId}`}
      repo={repo}
      canType={canType}
      onStatus={onStatus}
    />
  );
}

/** One pane of the layout (R4): a worker, a shell, a gate; it must be live. */
export function PaneTerminal({
  paneId,
  repo,
  canType,
  onStatus,
  onBlockedKey,
  onReady,
  scrollback,
}: {
  readonly paneId: string;
  readonly repo?: string | undefined;
  readonly canType: boolean;
  onStatus?: ((s: TerminalStatus) => void) | undefined;
  /** A key typed while the agent holds the keyboard (S6): the caller decides whether to take it. */
  onBlockedKey?: ((data: string) => void) | undefined;
  onReady?: ((handle: TerminalHandle) => void) | undefined;
  readonly scrollback?: number | undefined;
}) {
  return (
    <SocketTerminal
      path={`/ws/pane/${encodeURIComponent(paneId)}`}
      testId={`pane-${paneId}`}
      repo={repo}
      canType={canType}
      onStatus={onStatus}
      onBlockedKey={onBlockedKey}
      onReady={onReady}
      scrollback={scrollback}
    />
  );
}

function SocketTerminal({
  path,
  testId,
  repo,
  canType,
  onStatus,
  onBlockedKey,
  onReady,
  scrollback,
}: {
  readonly path: string;
  readonly testId: string;
  readonly repo?: string | undefined;
  readonly canType: boolean;
  onStatus?: ((s: TerminalStatus) => void) | undefined;
  onBlockedKey?: ((data: string) => void) | undefined;
  onReady?: ((handle: TerminalHandle) => void) | undefined;
  readonly scrollback?: number | undefined;
}) {
  const { url, me } = useDaemon();
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket>(null);
  const status = useRef<TerminalStatus>({});
  const report = useRef(onStatus);
  report.current = onStatus;
  const blocked = useRef(onBlockedKey);
  blocked.current = onBlockedKey;
  const ready = useRef(onReady);
  ready.current = onReady;
  const typing = useRef(canType);
  typing.current = canType;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      theme: { background: "#0b0e13", foreground: "#e6e9ef", cursor: "#2dd4bf" },
      convertEol: false,
      scrollback: scrollback ?? 5000,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(el);
    fit.fit();
    ready.current?.({
      findNext: (q) => search.findNext(q, { incremental: true }),
      findPrevious: (q) => search.findPrevious(q),
      copySelection: () => {
        const text = term.getSelection();
        if (text && typeof navigator !== "undefined" && navigator.clipboard)
          navigator.clipboard.writeText(text).catch(() => undefined);
        return text;
      },
      clearSearch: () => search.clearDecorations(),
      focus: () => term.focus(),
      scrollToBottom: () => term.scrollToBottom(),
    });
    const query = `?by=${encodeURIComponent(me)}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;
    const ws = new WebSocket(wsUrl(url, `${path}${query}`));
    socket.current = ws;
    const update = (s: TerminalStatus) => {
      status.current = s;
      report.current?.(s);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    ws.onmessage = (m) => {
      const e = JSON.parse(String(m.data)) as {
        type: string;
        data?: string;
        code?: number;
        reason?: string;
        session?: { alive: boolean };
        error?: { message: string };
      };
      if (e.type === "data" && typeof e.data === "string") term.write(e.data);
      else if (e.type === "session") update({ alive: e.session?.alive });
      else if (e.type === "exit") {
        term.write(`\r\n\x1b[90m[session ended with ${e.code}]\x1b[0m\r\n`);
        update({ alive: false, exitCode: e.code });
      } else if (e.type === "refused") update({ ...status.current, refused: e.reason });
      else if (e.type === "error") {
        term.write(`\r\n\x1b[31m${e.error?.message ?? "error"}\x1b[0m\r\n`);
        update({ alive: false });
      }
    };
    term.onData((data) => {
      if (!typing.current) {
        update({ ...status.current, refused: "attach first: the agent drives this session" });
        blocked.current?.(data);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });
    // A resize observed as the terminal is torn down (a route change) must not reach a disposed
    // renderer; the fit addon has no size either while the element is detached or hidden.
    let disposed = false;
    const observer = new ResizeObserver(() => {
      if (disposed || !el.isConnected || el.clientWidth === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    });
    observer.observe(el);
    return () => {
      disposed = true;
      observer.disconnect();
      ws.onmessage = null;
      ws.close();
      // xterm 5.5 syncs its viewport from a 0 ms timer set when the terminal opens and from
      // animation frames, and dispose() cancels neither; one that runs after dispose() reads
      // the dimensions of a renderer that is gone ("Cannot read properties of undefined
      // (reading 'dimensions')"). Chromium runs frames ahead of timers under load, so the
      // terminal goes only after a timer queued behind xterm's and two frames queued behind
      // its sync-then-refresh chain.
      setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => term.dispose())));
    };
    // The socket carries the attach state itself: a new `by` means a new socket.
  }, [path, repo, url, me, scrollback]);
  return <div className="term" ref={host} data-testid={testId} />;
}

/**
 * Sends a line the person typed in the composer (with Enter) to a run's conductor pane, or to the
 * pane named (R4).
 */
export function sendLine(
  runId: string,
  url: string,
  me: string,
  repo: string | undefined,
  line: string,
  paneId?: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const query = `?by=${encodeURIComponent(me)}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;
    const path = paneId ? `/ws/pane/${encodeURIComponent(paneId)}` : `/ws/pty/${encodeURIComponent(runId)}`;
    const ws = new WebSocket(wsUrl(url, `${path}${query}`));
    let done = false;
    const finish = (reason?: string) => {
      if (done) return;
      done = true;
      ws.close();
      resolve(reason);
    };
    // The line goes once the daemon has found the pane (its "session" message), so nothing is
    // typed into a socket that is still opening.
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      ws.send(JSON.stringify({ type: "input", data: `${line}\r` }));
      setTimeout(() => finish(), 300);
    };
    ws.onopen = () => {
      setTimeout(send, 2000);
    };
    ws.onmessage = (m) => {
      const e = JSON.parse(String(m.data)) as { type: string; reason?: string };
      if (e.type === "session") send();
      if (e.type === "refused") finish(e.reason);
      if (e.type === "error") finish(e.reason ?? "the daemon refused the terminal");
    };
    ws.onerror = () => finish("the daemon is unreachable");
  });
}
