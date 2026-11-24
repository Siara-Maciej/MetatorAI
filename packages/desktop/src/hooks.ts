/**
 * The hooks the screens share (D11): one option of the shown repository, an action with what it
 * answered, and the controls of one run (attach, release, the editor, its panes).
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { DaemonClient } from "./api.ts";
import { boardCards } from "./board.ts";
import { useDaemon } from "./daemon.tsx";
import type { HostEditor } from "./devcontainers.ts";
import { type Run, refusalText } from "./model.ts";
import { useHostEditor } from "./repos-context.tsx";
import { type WorkTask, workTasks } from "./tasks.ts";

/** The work as parent tasks (tasks.ts), from the runs and system plans: the sidebar's, Home's and a page's. */
export function useTasks(): WorkTask[] {
  const { runs, systemPlans } = useDaemon("runs", "systemPlans");
  return useMemo(
    () => workTasks(boardCards({ runs, issues: [], plans: systemPlans, now: Date.now() }), systemPlans),
    [runs, systemPlans],
  );
}

/** The value of one option (S1), or the fallback while the options are not here yet. */
export function useOption<T>(key: string, fallback: T): T {
  const { options } = useDaemon("options");
  return (options.find((o) => o.key === key)?.value as T | undefined) ?? fallback;
}

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
  const { me, who } = useDaemon("me", "who");
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

type RunRef = Pick<Run, "runId" | "repo" | "driver" | "attachedBy"> & {
  readonly worktree?: Pick<NonNullable<Run["worktree"]>, "path"> | undefined;
};

/**
 * The controls of one run, the same on the session screen and on the workbench (which has many
 * runs and asks for the controls of the one a pane belongs to).
 */
export function runControls(
  client: DaemonClient,
  action: Action,
  me: string,
  run: RunRef | undefined,
  editor?: HostEditor,
) {
  const runId = run?.runId;
  const repo = run?.repo;
  const none = () => Promise.resolve(false);
  return {
    /** The person holds the keyboard of this run. */
    attached: run?.driver === "human" && run.attachedBy === me && me !== "",
    /** Someone holds it: nobody else can attach. */
    taken: run?.driver === "human",
    attach: () => (runId ? action.run((by) => client.attach(runId, by, repo), { who: true }) : none()),
    release: () => (runId ? action.run(() => client.release(runId, repo)) : none()),
    /**
     * The run's directory in the person's editor (`editor.command`), at a file and line when given;
     * in a dev container, VS Code on this computer attached to it (round 21).
     */
    openEditor: (at: { file?: string; line?: number } = {}) => {
      if (!runId) return none();
      const onHost = editor?.({ ...at, worktree: run?.worktree?.path });
      return action.run(onHost ?? (() => client.openEditor(runId, at, repo)), {
        done: "opened in the editor",
      });
    },
    closePane: (paneId: string) => action.run(() => client.closePane(paneId, repo)),
    /**
     * Starts the run's conductor in a pane of its own (`POST /runs/:run/start`): the agent that
     * drives the run, in a terminal the person can watch and take. One of the two explicit ways a
     * process starts from a screen.
     */
    openSession: (host?: string) =>
      runId
        ? action.run((by) => client.start(runId, { by, ...(host ? { host } : {}) }, repo), {
            who: true,
            refused: "the session did not start",
          })
        : none(),
    /** The other: drives the run in the background, with no terminal (`metator run drive --detach`). */
    drive: (host?: string) =>
      runId
        ? action.run((by) => client.drive(runId, { by, ...(host ? { host } : {}) }, repo), {
            who: true,
            refused: "the drive did not start",
            done: "the run is driven in the background",
          })
        : none(),
  };
}

/** `runControls` of one run, for a screen that is about that run. */
export function useRunControls(run: RunRef | undefined, action: Action) {
  const { client, me } = useDaemon("client", "me");
  return runControls(client, action, me, run, useHostEditor());
}
