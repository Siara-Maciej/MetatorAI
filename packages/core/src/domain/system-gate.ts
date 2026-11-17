/**
 * The gate of a system run (W13, `system plan status --gate`): what its children say about going
 * on. Every step done passes; a step that can start sends the run back to start it (a new wave);
 * a child closed as aborted blocks it at once; a child that escalated makes it wait, blocked by
 * that child (the child's own card is what a person acts on; resumed, the run goes on by itself);
 * anything else is "not yet", until the run has waited longer than its timeout. Pure: the caller
 * reads the steps and the clock.
 */

export interface ChildStep {
  readonly id: string;
  readonly app: string;
  readonly status: string;
  readonly run?: string;
  readonly runStatus?: string;
  readonly stage?: string;
}

export type SystemGate =
  | { readonly kind: "pass" | "wave" | "waiting"; readonly message: string }
  | { readonly kind: "blocked"; readonly message: string; readonly hint?: string };

const hours = (ms: number) => `${Math.round(ms / 3_600_000)} h`;

/** One child as a person reads it: `shop-api working at build`, `shop-web not started`. */
export function childState(s: ChildStep): string {
  if (!s.run) return `${s.app} not started`;
  if (s.runStatus === "escalated")
    return `blocked by ${s.run} (${s.app}${s.stage ? `, at ${s.stage}` : ""}): needs you`;
  if (s.runStatus === "active") return `${s.app} working${s.stage ? ` at ${s.stage}` : ""}`;
  return `${s.app} ${s.runStatus ?? s.status}`;
}

export function systemGate(input: {
  readonly steps: readonly ChildStep[];
  /** The steps that can start now (their dependencies are done, they have no run yet). */
  readonly ready: readonly string[];
  /** How long the run has waited at this gate. */
  readonly waitedMs: number;
  readonly timeoutMs: number;
}): SystemGate {
  // Only a child that can no longer finish blocks the run; an escalated one waits for its person.
  const blocked = input.steps.find((s) => s.status === "blocked" && s.runStatus !== "escalated");
  if (blocked)
    return {
      kind: "blocked",
      message: `step ${blocked.id} is blocked: its run ${blocked.run ?? "(none)"} in ${blocked.app} ${blocked.runStatus ?? "stopped"}${blocked.stage ? ` at ${blocked.stage}` : ""}`,
      hint: "Its step cannot finish: change the system plan or close this run.",
    };
  if (input.steps.every((s) => s.status === "done")) return { kind: "pass", message: "every step is done" };
  if (input.ready.length > 0) return { kind: "wave", message: `a step can start: ${input.ready.join(", ")}` };
  const open = input.steps.filter((s) => s.status !== "done").map(childState);
  if (input.waitedMs > input.timeoutMs)
    return {
      kind: "blocked",
      message: `waited ${hours(input.waitedMs)} for the children, longer than ${hours(input.timeoutMs)}: ${open.join(", ")}`,
      hint: "Look at the child runs; resume this run to wait again.",
    };
  // A child that needs a person comes first: it is why the run does not move.
  const stuck = input.steps.filter((s) => s.status !== "done" && s.runStatus === "escalated");
  if (stuck.length > 0) {
    const rest = input.steps
      .filter((s) => s.status !== "done" && s.runStatus !== "escalated")
      .map(childState);
    return {
      kind: "waiting",
      message: [stuck.map(childState).join("; "), ...rest].join("; "),
    };
  }
  return { kind: "waiting", message: `waiting on children: ${open.join(", ")}` };
}
