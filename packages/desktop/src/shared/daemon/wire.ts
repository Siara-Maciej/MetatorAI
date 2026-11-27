/**
 * What came over the daemon's sockets last (ADR-0113: app-wide state, a store outside React): the
 * state and the inbox, whether the state's socket is open, what the daemon at an address last
 * refused, and the attempt Retry starts. The sockets write it; `<DaemonProvider>` reads it and
 * makes the daemon's state of it. What is written is shared with what was there (`shared`): a part
 * that did not change keeps its objects.
 */
import { createStore } from "zustand/vanilla";
import type { InboxData, InboxItem, PaneAsk, ReviewCardView, StateData } from "../api/api.ts";
import { shared } from "../api/query.ts";

export interface Wire {
  readonly state: StateData | undefined;
  readonly inbox: readonly InboxItem[];
  /** The questions of panes without a run (`/inbox`'s `panes`). */
  readonly paneAsks: readonly PaneAsk[];
  /** The reviews' cards (`/inbox`'s `reviews`). */
  readonly reviewCards: readonly ReviewCardView[];
  /** What the daemon at this address last refused: another address starts with nothing. */
  readonly failure: { readonly url: string; readonly message: string } | undefined;
  /** Retry's count: a new attempt opens the sockets again now. */
  readonly attempt: number;
  /** The state's socket is open. */
  readonly stateUp: boolean;
}

export const NO_INBOX: readonly InboxItem[] = [];
export const NO_PANE_ASKS: readonly PaneAsk[] = [];
export const NO_REVIEW_CARDS: readonly ReviewCardView[] = [];

export const wireStore = createStore<Wire>(() => ({
  state: undefined,
  inbox: NO_INBOX,
  paneAsks: NO_PANE_ASKS,
  reviewCards: NO_REVIEW_CARDS,
  failure: undefined,
  attempt: 0,
  stateUp: false,
}));

/** The daemon at `url` refused with `message`, or (undefined) answered. */
export function failed(url: string, message: string | undefined): void {
  wireStore.setState({ failure: message === undefined ? undefined : { url, message } });
}

/** The daemon's state, read over its socket or fetched. */
export function stateRead(next: StateData): void {
  wireStore.setState((w) => ({ state: shared(w.state, next) }));
}

/** The inbox: the decisions, the panes' questions, the reviews' cards. */
export function inboxRead(next: InboxData): void {
  wireStore.setState((w) => ({
    inbox: shared(w.inbox, next.decisions),
    paneAsks: shared(w.paneAsks, next.panes ?? NO_PANE_ASKS),
    reviewCards: shared(w.reviewCards, next.reviews ?? NO_REVIEW_CARDS),
  }));
}

/** The state's socket opened or closed. */
export function stateSocket(up: boolean): void {
  wireStore.setState({ stateUp: up });
}

/** Tries the daemon again now, without waiting for the next attempt. */
export function retry(): void {
  wireStore.setState((w) => ({ attempt: w.attempt + 1 }));
}
