/**
 * The one confirm of the app: the browser's own yes/no, asked before what cannot be taken back.
 * `useConfirmClose` asks before closing a live pane or chat while `ui.confirmClosePane` is on.
 */
import type { PaneView } from "./api/api.ts";
import { useOption } from "./hooks.ts";
import { closePaneQuestion, closeThreadQuestion } from "./model/confirm.ts";

/** No question: yes at once; otherwise the person's answer. */
export const confirmed = (question: string | undefined): boolean =>
  question === undefined || window.confirm(question);

export function useConfirmClose(): {
  pane(p: PaneView | undefined): boolean;
  thread(thread: { readonly title: string }, chat: PaneView | undefined): boolean;
} {
  const ask = useOption("ui.confirmClosePane", true);
  return {
    pane: (p) => confirmed(p ? closePaneQuestion(p, ask) : undefined),
    thread: (thread, chat) => confirmed(closeThreadQuestion(thread, chat, ask)),
  };
}
