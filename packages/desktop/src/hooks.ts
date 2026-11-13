/**
 * The hooks the screens share (D11): one option of the shown repository, an action with what it
 * answered, and the controls of one run (attach, release, the editor, its panes).
 */
import { useCallback, useRef, useState } from "react";
import type { Envelope } from "./api.ts";
import { useDaemon } from "./daemon.tsx";
import { type Run, refusalText } from "./model.ts";

/** The value of one option (S1), or the fallback while the options are not here yet. */
export function useOption<T>(key: string, fallback: T): T {
  const { options } = useDaemon();
  return (options.find((o) => o.key === key)?.value as T | undefined) ?? fallback;
}

/** What an action answered: the envelope's `ok` and its error. */
type Answer = Pick<Envelope<unknown>, "ok" | "error">;

export interface ActionNotice {
  readonly text: string | undefined;
  readonly tone: "error" | "info";
  onClose(): void;
}

export interface Action {
  /**
   * Runs a request and keeps what it answered: a refusal becomes the notice (it stays until
   * closed, D5), a success clears it (or says `done`), then the screen's data is read again.
   * With `who` the person's name is asked for first; a cancelled name dialog runs nothing.
   * Resolves to whether the daemon said yes.
   */
  run(
    fn: (by: string) => Promise<Answer>,
    options?: {
      /** Ask for the person's name first and pass it to `fn`. */
      readonly who?: boolean;
      /** What to say when the daemon refuses without a message. */
      readonly refused?: string;
      /** What to say (as information) when it worked. */
      readonly done?: string;
      /** The last refusal, for what the screen offers next (a start from the last commit). */
      onRefused?(error: Answer["error"]): void;
    },
  ): Promise<boolean>;
  /** Spread into `<Notice>`. */
  readonly notice: ActionNotice;
  readonly busy: boolean;
  say(text: string | undefined, tone?: "error" | "info"): void;
}

/** One action at a time with one notice: the request, the refusal that stays, the reload after. */
export function useAction(reload?: () => Promise<unknown> | unknown): Action {
  const { me, who } = useDaemon();
  const [note, setNote] = useState<{ text: string; tone: "error" | "info" }>();
  const [busy, setBusy] = useState(false);
  const latest = useRef(reload);
  latest.current = reload;
  const name = useRef(me);
  name.current = me;
  const run = useCallback<Action["run"]>(
    async (fn, options = {}) => {
      const by = options.who ? await who() : name.current;
      if (options.who && !by) return false;
      setBusy(true);
      const r = await fn(by);
      setBusy(false);
      if (r.ok) setNote(options.done ? { text: options.done, tone: "info" } : undefined);
      else {
        setNote({ text: refusalText(r.error, options.refused), tone: "error" });
        options.onRefused?.(r.error);
      }
      await latest.current?.();
      return r.ok;
    },
    [who],
  );
  return {
    run,
    busy,
    notice: { text: note?.text, tone: note?.tone ?? "error", onClose: () => setNote(undefined) },
    say: (text, tone = "error") => setNote(text ? { text, tone } : undefined),
  };
}

/** The controls of one run, the same on the session screen and on the workbench. */
export function useRunControls(run: Pick<Run, "runId" | "repo" | "driver" | "attachedBy"> | undefined, action: Action) {
  const { client, me } = useDaemon();
  const runId = run?.runId;
  const repo = run?.repo;
  /** The person holds the keyboard of this run. */
  const attached = run?.driver === "human" && run.attachedBy === me && me !== "";
  return {
    attached,
    /** Someone holds it: nobody else can attach. */
    taken: run?.driver === "human",
    attach: () =>
      runId ? action.run((by) => client.attach(runId, by, repo), { who: true }) : Promise.resolve(false),
    release: () => (runId ? action.run(() => client.release(runId, repo)) : Promise.resolve(false)),
    /** The run's directory in the person's editor (`editor.command`), at a file and line when given. */
    openEditor: (at: { file?: string; line?: number } = {}) =>
      runId
        ? action.run(() => client.openEditor(runId, at, repo), { done: "opened in the editor" })
        : Promise.resolve(false),
    closePane: (paneId: string) => action.run(() => client.closePane(paneId, repo)),
    /** Starts the run's terminal session: the one explicit way a process starts from a screen. */
    openSession: () =>
      runId
        ? action.run(() => client.ptyOpen(runId, repo), { refused: "the session did not start" })
        : Promise.resolve(false),
  };
}
