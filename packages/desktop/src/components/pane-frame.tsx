/**
 * One pane of the workbench (S6): its frame with what runs in it and its state, its terminal,
 * what to do when its process ended, the question "take the keyboard?" and the copy-mode search.
 */
import { useRef } from "react";
import type { PaneView } from "../api.ts";
import { lookOf, type PaneShown, paneLabel, paneNote } from "../model.ts";
import { endedBanner, pausedBanner } from "../terminals.ts";
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
  needsYou,
  onFocus,
  onMenu,
  onZoom,
  onBlockedKey,
  onReady,
  onRetry,
  onContinue,
  onClose,
}: {
  /** A paused pane started again in place (round 11). */
  onContinue?: (() => void) | undefined;
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
  /** A question of this pane waits for the person (a pane without a run, ADR-0091). */
  readonly needsYou?: boolean | undefined;
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
          {needsYou ? (
            <span className="amber" data-testid={`needs-you-${p.id}`}>
              {" "}
              · needs you
            </span>
          ) : null}
          {paneNote(p, state) ? <span className="faint"> · {paneNote(p, state)}</span> : null}
          {mine ? <span className="teal"> · yours</span> : null}
        </button>
      ) : null}
      {/* A paused pane has no process, but its socket serves its last screen, read-only. */}
      {p.live || pausedBanner(p) ? (
        <PaneTerminal
          // A new session in the same pane (Retry on a conductor) is a new terminal.
          key={p.live?.sessionId ?? `paused:${p.id}`}
          paneId={p.id}
          repo={repo}
          canType={(p.live?.alive ?? false) && !p.ended && !pausedBanner(p) && canType}
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
      {pausedBanner(p) && !p.ended ? (
        // Its host stopped with the daemon (or was lost); the work is not over: Continue starts it in place.
        <div className="pane-ended paused-banner" role="status" data-testid={`paused-${p.id}`}>
          <span className="msg">{pausedBanner(p)}</span>
          <button type="button" className="primary" onClick={onContinue ?? onRetry}>
            Continue
          </button>
        </div>
      ) : p.ended || (p.live && !p.live.alive) ? (
        // The pane's work is over (the daemon says so, or its process is gone a moment before): it stays, read-only, with what ended it, until it is closed.
        <div
          className={`pane-ended finished-banner ${endedBanner(p).tone}`}
          role="status"
          data-testid={`ended-${p.id}`}
        >
          <span className={endedBanner(p).tone === "done" ? "msg done" : "msg red"}>
            {endedBanner(p).text}
          </span>
          {endedBanner(p).tone === "error" ? (
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          ) : null}
          <button type="button" className="primary" onClick={onClose}>
            {lastOfTab ? "Close tab" : "Close"}
          </button>
        </div>
      ) : p.live?.alive ? null : (
        <div className="pane-ended" role="status" data-testid={`ended-${p.id}`}>
          <span className="msg">
            Nothing runs in this pane: its process did not start, or the daemon was restarted.
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
