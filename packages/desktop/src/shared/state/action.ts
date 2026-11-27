/**
 * An action of a screen in its store (ADR-0113): one request at a time, whether one runs (`busy`)
 * and what it answered (`notice`: a refusal stays until closed, D5) are fields of the screen's store,
 * so only the parts that show them draw again. The person's name is read from the daemon's store at
 * the moment of the action.
 */
import type { StoreApi } from "zustand/vanilla";
import type { Daemon } from "../daemon/daemon.tsx";
import type { Store } from "../daemon/daemon-store.ts";
import { refusalText } from "../model/format.ts";

interface ActionNotice {
  readonly text: string;
  readonly tone: "error" | "info";
}

/** The part of a screen's state an action writes. */
export interface ActionState {
  readonly busy: boolean;
  readonly notice: ActionNotice | undefined;
}

export const IDLE: ActionState = { busy: false, notice: undefined };

/** What an action answered: the envelope's `ok` and what it says of a refusal. */
export interface Answer {
  readonly ok: boolean;
  readonly error?:
    | {
        readonly message?: string;
        readonly hint?: string;
        readonly details?: Readonly<Record<string, unknown>>;
      }
    | undefined;
}

export interface ActionOptions {
  /** Ask for the person's name first and pass it to the request; a cancelled dialog runs nothing. */
  readonly who?: boolean;
  /** What to say when the daemon refuses without a message. */
  readonly refused?: string;
  /** What to say (as information) when it worked. */
  readonly done?: string;
  /** The refusal, for what the screen offers next (a start from the last commit). */
  readonly onRefused?: (error: Answer["error"]) => void;
  /** The screen's data read again after the answer. */
  readonly reload?: () => unknown;
}

/**
 * Runs a request: `busy` while it runs, then its refusal as the notice, or a success that clears it
 * (or says `done`). Resolves to whether the daemon said yes.
 */
export async function runAction(
  store: StoreApi<ActionState>,
  daemon: Store<Pick<Daemon, "me" | "who">>,
  request: (by: string) => Promise<Answer>,
  options: ActionOptions = {},
): Promise<boolean> {
  const { me, who } = daemon.getState();
  const by = options.who ? await who() : me;
  if (options.who && !by) return false;
  store.setState({ busy: true });
  const r = await request(by);
  store.setState({
    busy: false,
    notice: r.ok
      ? options.done
        ? { text: options.done, tone: "info" }
        : undefined
      : { text: refusalText(r.error, options.refused), tone: "error" },
  });
  if (!r.ok) options.onRefused?.(r.error);
  await options.reload?.();
  return r.ok;
}

/** Says a line in the screen's notice, or clears it with `undefined`. */
export function sayIn(
  store: StoreApi<ActionState>,
  text: string | undefined,
  tone: "error" | "info" = "error",
): void {
  store.setState({ notice: text ? { text, tone } : undefined });
}
