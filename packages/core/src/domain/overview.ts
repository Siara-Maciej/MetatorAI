/**
 * The overview of work (G4, ADR-0059): where each run is in its workflow and who has to act
 * next. `metator status` returns it; `metator ui` draws it.
 */

/** done · current (an agent or a script works) · waiting (a person must act) · next · stopped. */
export type StageState = "done" | "current" | "waiting" | "next" | "stopped";

export interface StageProgress {
  readonly id: string;
  readonly state: StageState;
  /** A human gate: only an approval moves the run on. */
  readonly hitl: boolean;
}

/** Who has to act: you · the drive · nobody yet (stopped) · nobody any more. */
export type Attention = "you" | "driving" | "stopped" | "done" | "escalated" | "aborted";

export interface StageInput {
  readonly id: string;
  readonly hitl?: boolean | undefined;
}

/**
 * Each stage's state from the run's current stage and status. A run that finished has done every
 * stage; one that escalated or was aborted stopped at its stage.
 */
export function stageProgress(
  stages: readonly StageInput[],
  current: string,
  status: string,
  waiting: number,
): StageProgress[] {
  const at = stages.findIndex((s) => s.id === current);
  return stages.map((s, i) => {
    const hitl = s.hitl === true;
    let state: StageState;
    if (status === "done" || (at >= 0 && i < at)) state = "done";
    else if (i === at) {
      if (status === "escalated" || status === "aborted") state = "stopped";
      else state = hitl || waiting > 0 ? "waiting" : "current";
    } else state = "next";
    return { id: s.id, state, hitl };
  });
}

/**
 * The stage a run is at. A run that escalated or was aborted is in its end state, not a stage:
 * it stopped at the stage its history ends with.
 */
export function stoppedAt(
  stage: string,
  status: string,
  history: readonly { readonly stage: string }[],
): string {
  if (stage !== status || (status !== "escalated" && status !== "aborted")) return stage;
  return history.at(-1)?.stage ?? stage;
}

export function attentionOf(
  status: string,
  waiting: number,
  driving: boolean,
  atHumanGate: boolean,
): Attention {
  if (status === "done" || status === "escalated" || status === "aborted") return status;
  if (waiting > 0) return "you";
  // A gate with nobody driving waits for you as well: approve it, or continue the run.
  if (atHumanGate && !driving) return "you";
  return driving ? "driving" : "stopped";
}

const ORDER: Readonly<Record<Attention, number>> = {
  you: 0,
  driving: 1,
  stopped: 2,
  escalated: 3,
  done: 4,
  aborted: 5,
};

/** Who must act first comes first; within that, the most recently changed, then the newest run. */
export function byAttention<
  T extends { readonly attention: Attention; readonly updatedAt: string; readonly runId?: string },
>(runs: readonly T[]): T[] {
  return [...runs].sort(
    (a, b) =>
      ORDER[a.attention] - ORDER[b.attention] ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      (b.runId ?? "").localeCompare(a.runId ?? ""),
  );
}

export interface AttentionCounts {
  readonly you: number;
  readonly driving: number;
  readonly stopped: number;
  /** Escalated runs: a person removes the cause and resumes them. */
  readonly escalated: number;
  readonly finished: number;
}

export function countAttention(runs: readonly { readonly attention: Attention }[]): AttentionCounts {
  const n = (a: Attention) => runs.filter((r) => r.attention === a).length;
  return {
    you: n("you"),
    driving: n("driving"),
    stopped: n("stopped"),
    escalated: n("escalated"),
    finished: runs.length - n("you") - n("driving") - n("stopped"),
  };
}
