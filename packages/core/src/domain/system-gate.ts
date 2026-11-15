/**
 * The gate of a system run (W13, `system plan status --gate`): what its children say about going
 * on. Every step done passes; a step that can start sends the run back to start it (a new wave);
 * a child that escalated or was aborted blocks it at once; anything else is "not yet", until the
 * run has waited longer than its timeout. Pure: the caller reads the steps and the clock.
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
  const blocked = input.steps.find((s) => s.status === "blocked");
  if (blocked)
    return {
      kind: "blocked",
      message: `step ${blocked.id} is blocked: its run ${blocked.run ?? "(none)"} in ${blocked.app} ${blocked.runStatus ?? "stopped"}${blocked.stage ? ` at ${blocked.stage}` : ""}`,
      hint: `Resolve that run in ${blocked.app} (resume or close it), then resume this run.`,
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
  return { kind: "waiting", message: `waiting on children: ${open.join(", ")}` };
}
