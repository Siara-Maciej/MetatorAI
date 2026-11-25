/**
 * Continue (round 11): the whole task, or one paused pane, started again where it stopped; the
 * daemon says what it did (`continueText`).
 */
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import type { Action } from "../../shared/hooks.ts";
import { Button } from "../../ui/button.tsx";
import { continueText } from "./terminals.ts";

/** Continues a run's paused panes and undriven runs, or one paused pane (`POST /panes/:pane/continue`). */
export function useContinue(
  action: Action,
): (
  what: { readonly runId: string } | { readonly paneId: string },
  repo: string | undefined,
) => Promise<void> {
  const { client } = useDaemon("client");
  return async (what, repo) => {
    let said: string | undefined;
    await action.run(
      async (by) => {
        const r =
          "runId" in what
            ? await client.continueRun(what.runId, by, repo)
            : await client.continuePane(what.paneId, by, repo);
        if (r.ok && r.data) said = continueText(r.data);
        return r;
      },
      { who: true, refused: "Nothing was continued" },
    );
    if (said) action.say(said, "info");
  };
}

/** "Continue task", on the bar or the task's tile, while something of the task is paused or undriven. */
export function ContinueTask({
  where,
  pending,
  onContinue,
}: {
  readonly where: "bar" | "tile";
  readonly pending: { readonly paused: number; readonly undriven: number };
  onContinue(): void;
}) {
  if (pending.paused + pending.undriven === 0) return null;
  return (
    <Button
      variant="primary"
      data-testid={where === "bar" ? "continue-task" : "continue-task-tile"}
      title={`${pending.paused} paused terminal(s), ${pending.undriven} run(s) nothing drives`}
      onClick={onContinue}
    >
      Continue task
    </Button>
  );
}
