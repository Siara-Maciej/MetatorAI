/**
 * One pane of the workbench (S6): its frame with what runs in it and its state, its terminal,
 * what to do when its process ended, the question "take the keyboard?" and the copy-mode search.
 */
import { useRef } from "react";
import type { PaneView } from "../api.ts";
import { lookOf, type PaneShown, paneLabel } from "../model.ts";
import { Glyph } from "./glyph.tsx";
import { PaneTerminal, type TerminalHandle } from "./terminal.tsx";

export function PaneFrame({
  pane: p,
  state,
  repo,
  focused,
  framed,
  labels,
  symbols,
  mine,
  canType,
  scrollback,
  asking,
  copying,
  lastOfTab,
  onFocus,
  onMenu,
  onZoom,
  onBlockedKey,
  onReady,
  onRetry,
  onClose,
}: {
  readonly pane: PaneView;
  readonly state: PaneShown;
  readonly repo: string | undefined;
  readonly focused: boolean;
  /** `ui.paneBorders`, `ui.paneLabels`, `ui.statusIndicators`. */
  readonly framed: boolean;
  readonly labels: boolean;
  readonly symbols: boolean;
  /** The person holds the keyboard of this pane's run. */
  readonly mine: boolean;
  readonly canType: boolean;
  readonly scrollback: number;
  /** "Take the keyboard?" is asked on this pane. */
  readonly asking: boolean;
  /** Copy mode is on in this pane. */
  readonly copying: boolean;
  /** The only pane of its tab: closing it closes the tab. */
  readonly lastOfTab: boolean;
  onFocus(): void;
  onMenu(e: React.MouseEvent): void;
  onZoom(): void;
  onBlockedKey(): void;
  onReady(handle: TerminalHandle): void;
  onRetry(): void;
  onClose(): void;
}) {
  const handle = useRef<TerminalHandle | undefined>(undefined);
  const query = useRef("");
  return (
    <section
      className={`pane-frame${framed ? " framed" : ""}${focused ? " focus" : ""} s-${state}`}
      aria-label={`${paneLabel(p)} ${p.id}`}
      data-testid={`frame-${p.id}`}
      data-state={state}
      onMouseDown={onFocus}
      onContextMenu={onMenu}
    >
      {labels ? (
        <button
          type="button"
          className="title"
          onClick={onFocus}
          onDoubleClick={onZoom}
          title={`${p.state?.reason ?? p.id} (double click: zoom)`}
        >
          {paneLabel(p)}
          {p.process.kind === "host" ? <span className="faint"> · {p.process.host}</span> : null}
          <span className={lookOf("pane", state).tone}>
            {" · "}
            {symbols ? <Glyph kind="pane" state={state} /> : null} {state}
          </span>
          {mine ? <span className="teal"> · yours</span> : null}
        </button>
      ) : null}
      {p.live ? (
        <PaneTerminal
          // A new session in the same pane (Retry on a conductor) is a new terminal.
          key={p.live.sessionId}
          paneId={p.id}
          repo={repo}
          canType={p.live.alive && canType}
          scrollback={scrollback}
          onBlockedKey={() => (p.live?.alive ? onBlockedKey() : undefined)}
          onReady={(h) => {
            handle.current = h;
            onReady(h);
          }}
        />
      ) : (
        <div className="empty" />
      )}
      {p.live?.alive ? null : (
        <div
          className="pane-ended"
          role="status"
          data-testid={`ended-${p.id}`}
          title={p.live ? "The pane keeps the last output of the process." : undefined}
        >
          <span className="msg">
            {p.live
              ? `The process ended${p.live.exitCode !== undefined ? ` with code ${p.live.exitCode}` : ""}.`
              : "Nothing runs in this pane: its process did not start, or the daemon was restarted."}
          </span>
          <button type="button" className="primary" onClick={onRetry}>
            Retry
          </button>
          <button type="button" onClick={onClose}>
            {lastOfTab ? "Close tab" : "Close pane"}
          </button>
        </div>
      )}
      {asking ? (
        <div className="ask" role="alert">
          Take the keyboard of {paneLabel(p)}? <kbd>↵</kbd> yes · <kbd>esc</kbd> no
        </div>
      ) : null}
      {copying ? (
        <search className="copy-mode">
          <span className="faint">copy mode</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: opened by a key, the search field is where the keys go
            autoFocus
            aria-label="search the scrollback"
            onChange={(e) => {
              query.current = e.target.value;
              handle.current?.findNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                handle.current?.[e.shiftKey ? "findPrevious" : "findNext"](query.current);
            }}
          />
          <span className="faint">
            <kbd>↵</kbd> next · <kbd>⇧↵</kbd> previous · select with the mouse, <kbd>y</kbd> copies ·{" "}
            <kbd>esc</kbd>
          </span>
        </search>
      ) : null}
    </section>
  );
}
