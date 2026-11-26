/**
 * What the app asks before closing something whose process still lives (`ui.confirmClosePane`):
 * a pane on the Terminals or a run's Terminal tab, and a chat whose agent is stopped by Close chat.
 * Undefined: nothing is lost, close at once.
 */
import type { PaneView } from "../api/api.ts";
import { paneLabel } from "./panes.ts";

type Closable = Pick<PaneView, "id" | "role" | "label" | "worker" | "process"> & {
  readonly live?: { readonly alive: boolean } | undefined;
  readonly ended?: unknown;
};

const lives = (p: Closable): boolean => p.live?.alive === true && !p.ended;

export function closePaneQuestion(p: Closable, ask: boolean): string | undefined {
  return ask && lives(p) ? `Close ${paneLabel(p)} (${p.id})?` : undefined;
}

export function closeThreadQuestion(
  thread: { readonly title: string },
  chat: Closable | undefined,
  ask: boolean,
): string | undefined {
  return ask && chat && lives(chat)
    ? `Close the chat "${thread.title}"? Its agent stops; its tasks go on.`
    : undefined;
}
