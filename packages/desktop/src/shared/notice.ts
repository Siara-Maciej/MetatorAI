/**
 * What an action of the app answered, shown under the top bar (D5): a refusal stays until it is
 * closed or replaced; a confirmation goes by itself, and goes with the place it was about. Any
 * part of the app says it here instead of handing a callback up to the shell.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export interface ShellNotice {
  readonly text: string;
  readonly tone: "error" | "info";
  /** Set together with a move to another place: it lives through that one move. */
  readonly sticky?: boolean;
}

const noticeStore = createStore<{ readonly notice: ShellNotice | undefined }>(() => ({
  notice: undefined,
}));

/** Says it (or clears what was said with undefined). */
export function say(notice: ShellNotice | undefined): void {
  noticeStore.setState({ notice });
}

/** The app moved to another place: what the last one said goes, but a sticky confirmation stays once. */
export function noticeAfterMove(): void {
  noticeStore.setState(({ notice: n }) => ({
    notice: n?.tone !== "info" ? n : n.sticky ? { ...n, sticky: false } : undefined,
  }));
}

/** A confirmation that is still the one shown goes. */
export function noticeExpired(notice: ShellNotice): void {
  noticeStore.setState(({ notice: n }) => ({ notice: n === notice ? undefined : n }));
}

export const useShellNotice = (): ShellNotice | undefined => useStore(noticeStore, (s) => s.notice);
