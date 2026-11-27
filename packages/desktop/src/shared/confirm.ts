/**
 * The one confirm of the app: the browser's own yes/no, asked before what cannot be taken back.
 * Closing a live pane or chat asks while `ui.confirmClosePane` is on (`model/confirm.ts` says
 * what; the screens' stores ask it with `confirmed`).
 */

/** No question: yes at once; otherwise the person's answer. */
export const confirmed = (question: string | undefined): boolean =>
  question === undefined || window.confirm(question);
