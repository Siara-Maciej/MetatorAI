import { assign, initialTransition, setup, transition } from "xstate";
import { MetatorError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

/**
 * Workflow run state machine on XState v5 (ADR-0013). A declarative workflow spec is compiled
 * into an XState machine; transitions use XState's pure `transition()` API, and the persisted
 * snapshot is plain JSON (`.metator/runs/<id>/state.json`), so a run can resume anywhere.
 */

export interface StageSpec {
  readonly id: string;
  /** Human-in-the-loop gate: only APPROVE moves on. */
  readonly hitl?: boolean;
  /** On FAIL go back to `goto`, counting against the named loop limit; escalate when exhausted. */
  readonly onFail?: { readonly goto: string; readonly loop: string };
}

export interface WorkflowSpec {
  readonly id: string;
  readonly stages: readonly StageSpec[];
  readonly loops?: Readonly<Record<string, number>>;
}

export type RunEvent =
  | { readonly type: "PASS" }
  | { readonly type: "FAIL"; readonly reason?: string }
  | { readonly type: "APPROVE"; readonly by: string; readonly choice?: string }
  | { readonly type: "ABORT"; readonly reason: string };

export interface RunHistoryEntry {
  readonly stage: string;
  readonly event: RunEvent["type"];
  readonly detail?: string;
}

export interface RunContext {
  readonly loops: Readonly<Record<string, number>>;
  readonly history: readonly RunHistoryEntry[];
}

export type RunStatus = "active" | "done" | "escalated" | "aborted";

/** JSON-serializable run state: what gets written to state.json. */
export interface RunState {
  readonly workflow: string;
  readonly stage: string;
  readonly status: RunStatus;
  readonly context: RunContext;
}

const TERMINAL: Record<string, RunStatus> = { done: "done", escalated: "escalated", aborted: "aborted" };

function record(stage: string, event: RunEvent): RunHistoryEntry {
  const detail =
    event.type === "FAIL"
      ? event.reason
      : event.type === "APPROVE"
        ? event.by
        : event.type === "ABORT"
          ? event.reason
          : undefined;
  return detail === undefined ? { stage, event: event.type } : { stage, event: event.type, detail };
}

function validate(spec: WorkflowSpec): MetatorError | undefined {
  const ids = spec.stages.map((s) => s.id);
  if (ids.length === 0) return new MetatorError("INVALID_CONFIG", `Workflow ${spec.id} has no stages`);
  const reserved = ids.find((id) => id in TERMINAL);
  if (reserved) return new MetatorError("INVALID_CONFIG", `Stage id "${reserved}" is reserved`);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) return new MetatorError("INVALID_CONFIG", `Duplicate stage "${duplicate}" in ${spec.id}`);
  for (const stage of spec.stages) {
    if (!stage.onFail) continue;
    if (!ids.includes(stage.onFail.goto)) {
      return new MetatorError(
        "INVALID_CONFIG",
        `Stage "${stage.id}" loops to unknown stage "${stage.onFail.goto}"`,
      );
    }
    if (spec.loops?.[stage.onFail.loop] === undefined) {
      return new MetatorError(
        "INVALID_CONFIG",
        `Stage "${stage.id}" uses undefined loop limit "${stage.onFail.loop}"`,
        {
          hint: `Add loops.${stage.onFail.loop} to the workflow spec.`,
        },
      );
    }
  }
  return undefined;
}

function compile(spec: WorkflowSpec) {
  const limits = spec.loops ?? {};
  const machineSetup = setup({
    types: { context: {} as RunContext, events: {} as RunEvent },
  });

  const states: Record<string, object> = {
    done: { type: "final" },
    escalated: { type: "final" },
    aborted: { type: "final" },
  };

  spec.stages.forEach((stage, index) => {
    const next = spec.stages[index + 1]?.id ?? "done";
    const log = assign(({ context, event }: { context: RunContext; event: RunEvent }) => ({
      history: [...context.history, record(stage.id, event)],
    }));
    const advance = { target: next, actions: log };
    const fail = stage.onFail
      ? [
          {
            target: stage.onFail.goto,
            guard: ({ context }: { context: RunContext }) =>
              (context.loops[(stage.onFail as NonNullable<StageSpec["onFail"]>).loop] ?? 0) <
              (limits[(stage.onFail as NonNullable<StageSpec["onFail"]>).loop] ?? 0),
            actions: [
              log,
              assign(({ context }: { context: RunContext }) => {
                const loop = (stage.onFail as NonNullable<StageSpec["onFail"]>).loop;
                return { loops: { ...context.loops, [loop]: (context.loops[loop] ?? 0) + 1 } };
              }),
            ],
          },
          { target: "escalated", actions: log },
        ]
      : { target: "escalated", actions: log };

    states[stage.id] = {
      on: {
        ...(stage.hitl ? { APPROVE: advance } : { PASS: advance }),
        FAIL: fail,
        ABORT: { target: "aborted", actions: log },
      },
    };
  });

  return machineSetup.createMachine({
    id: spec.id,
    initial: (spec.stages[0] as StageSpec).id,
    context: { loops: {}, history: [] },
    // Generated from the spec; XState validates the shape at creation time.
    states: states as never,
  });
}

export class RunStateMachine {
  private constructor(
    private readonly spec: WorkflowSpec,
    private readonly machine: ReturnType<typeof compile>,
  ) {}

  static create(spec: WorkflowSpec): Result<RunStateMachine, MetatorError> {
    const invalid = validate(spec);
    return invalid ? err(invalid) : ok(new RunStateMachine(spec, compile(spec)));
  }

  start(): RunState {
    const [snapshot] = initialTransition(this.machine);
    return this.toState(snapshot);
  }

  /** Applies an event to a (possibly deserialized) state. Rejected events change nothing. */
  send(state: RunState, event: RunEvent): Result<RunState, MetatorError> {
    if (state.workflow !== this.spec.id) {
      return err(
        new MetatorError(
          "TRANSITION_DENIED",
          `State belongs to workflow ${state.workflow}, not ${this.spec.id}`,
        ),
      );
    }
    const snapshot = this.machine.resolveState({ value: state.stage, context: state.context as RunContext });
    if (!snapshot.can(event)) {
      return err(
        new MetatorError(
          "TRANSITION_DENIED",
          `Stage "${state.stage}" (${state.status}) does not accept ${event.type}`,
          {
            hint: this.expected(state),
            details: { stage: state.stage, event: event.type },
          },
        ),
      );
    }
    const [next] = transition(this.machine, snapshot, event);
    return ok(this.toState(next));
  }

  private expected(state: RunState): string {
    if (state.status !== "active") return `The run is ${state.status}; start a new run.`;
    const stage = this.spec.stages.find((s) => s.id === state.stage);
    return stage?.hitl
      ? "This gate needs APPROVE (human decision), FAIL or ABORT."
      : "Send PASS, FAIL or ABORT.";
  }

  private toState(snapshot: { readonly value: unknown; readonly context: RunContext }): RunState {
    const stage = String(snapshot.value);
    return {
      workflow: this.spec.id,
      stage,
      status: TERMINAL[stage] ?? "active",
      context: structuredClone(snapshot.context),
    };
  }
}
