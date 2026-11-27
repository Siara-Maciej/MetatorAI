/**
 * Continue (round 11): the whole task, or one paused pane, started again where it stopped; the
 * daemon says what it did (`continueText`). The request is the Terminals store's (`state.ts`).
 */
import { Button } from "../../ui/button.tsx";

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
