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

/** What a shared control (`runControls`, `<StartRun>`) is given to act with: a request and its answer. */
export interface Action {
  /**
   * Runs a request and keeps what it answered: a refusal becomes the notice (it stays until
   * closed, D5), a success clears it (or says `done`), then the screen's data is read again.
   * With `who` the person's name is asked for first; a cancelled name dialog runs nothing.
   * Resolves to whether the daemon said yes.
   */
  run(
    fn: (by: string) => Promise<Answer>,
    options?: Pick<ActionOptions, "who" | "refused" | "done" | "onRefused">,
  ): Promise<boolean>;
  /** Spread into `<Notice>`. */
  readonly notice: {
    readonly text: string | undefined;
    readonly tone: "error" | "info";
    onClose(): void;
  };
  readonly busy: boolean;
  say(text: string | undefined, tone?: "error" | "info"): void;
}

/**
 * A screen store's action as the `Action` the shared controls take: the request runs through
 * `runAction`, so `busy` and the notice are fields of the screen's store. `busy` is what the calling
 * part read from the store (it draws again when it changes); `reload` reads the screen's data again
 * after each answer; the notice is the store's at the moment it is read.
 */
export function asAction(
  store: StoreApi<ActionState>,
  daemon: Store<Pick<Daemon, "me" | "who">>,
  busy = false,
  reload?: () => unknown,
): Action {
  return {
    run: (fn, options = {}) => runAction(store, daemon, fn, reload ? { ...options, reload } : options),
    busy,
    get notice() {
      const notice = store.getState().notice;
      return { text: notice?.text, tone: notice?.tone ?? "error", onClose: () => sayIn(store, undefined) };
    },
    say: (text, tone) => sayIn(store, text, tone),
  };
}
