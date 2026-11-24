/**
 * The controls of one run (attach, release, the editor, its panes, a session or a drive), the same on the run's page and on the Terminals.
 */
import type { DaemonClient } from "../../shared/api/api.ts";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import type { Action } from "../../shared/hooks.ts";
import type { Run } from "../../shared/model/runs.ts";
import type { HostEditor } from "../repos/devcontainers.ts";
import { useHostEditor } from "../repos/repos-context.tsx";

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
