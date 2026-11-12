import { assign, initialTransition, setup, transition } from "xstate";
import { MetatorError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";
import type { RunContext, RunHistoryEntry, RunState, RunStatus } from "./run-record.ts";
import {
  type StageSpec,
  validateWorkflowSpec,
  type WorkflowSpec,
  type WorkflowSpecInput,
} from "./workflow-spec.ts";

/**
 * Workflow run state machine on XState v5 (ADR-0013). A declarative workflow spec is compiled
 * into an XState machine; transitions use XState's pure `transition()` API, and the persisted
 * snapshot is plain JSON (`.metator/runs/<id>/state.json`), so a run can resume anywhere.
 */

export type RunEventType = RunEvent["type"];

export type RunEvent =
  | { readonly type: "PASS" }
  | { readonly type: "FAIL"; readonly reason?: string }
  | { readonly type: "APPROVE"; readonly by: string; readonly choice?: string }
  | { readonly type: "ABORT"; readonly reason: string };

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

function compile(spec: WorkflowSpec) {
  const limits = spec.loops;
  const machineSetup = setup({
    types: { context: {} as RunContext, events: {} as RunEvent },
  });

  const states: Record<string, object> = {
    done: { type: "final" },
    escalated: { type: "final" },
    aborted: { type: "final" },
  };

  /** The loops of the stages from `goto` up to (not including) the stage at `index`. */
  const roundLoops = (index: number, goto: string): string[] => {
    const from = spec.stages.findIndex((s) => s.id === goto);
    return spec.stages.slice(Math.max(from, 0), index).flatMap((s) => (s.onFail ? [s.onFail.loop] : []));
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
                // A later stage sending the run back starts a new round: the loops of the stages it
                // goes back over count from zero again (a plan the review sent back gets its own
                // plan-gate tries). The loop that sent it back keeps counting, so this ends.
                const fresh = Object.fromEntries(
                  roundLoops(index, (stage.onFail as NonNullable<StageSpec["onFail"]>).goto)
                    .filter((l) => l !== loop)
                    .map((l) => [l, 0]),
                );
                return { loops: { ...context.loops, ...fresh, [loop]: (context.loops[loop] ?? 0) + 1 } };
              }),
            ],
          },
          { target: "escalated", actions: log },
        ]
      : // An optional stage that fails is skipped: the run goes on without what it would have added.
        { target: stage.optional ? next : "escalated", actions: log };

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

  /** Validates the spec with its zod schema (single source of truth), then compiles it. */
  static create(spec: WorkflowSpecInput | WorkflowSpec): Result<RunStateMachine, MetatorError> {
    return validateWorkflowSpec(spec, spec.id).map((valid) => new RunStateMachine(valid, compile(valid)));
  }

  get workflow(): WorkflowSpec {
    return this.spec;
  }

  /** Events the current stage accepts; empty for terminal states. */
  expects(state: RunState): RunEventType[] {
    if (state.status !== "active") return [];
    const stage = this.spec.stages.find((s) => s.id === state.stage);
    return stage?.hitl ? ["APPROVE", "FAIL", "ABORT"] : ["PASS", "FAIL", "ABORT"];
  }

  /**
   * True when the run waits at a human gate its autonomy level may skip (`skipAt`, autopilot),
   * never at a gate marked `neverSkip`.
   */
  skippable(state: RunState, autonomy: string): boolean {
    if (state.status !== "active") return false;
    const stage = this.spec.stages.find((s) => s.id === state.stage);
    return !!stage?.hitl && !stage.neverSkip && (stage.skipAt ?? []).some((level) => level === autonomy);
  }

  /** True when a FAIL at this stage skips it (an optional stage with no `onFail` to loop on). */
  skipsOnFail(stageId: string): boolean {
    const stage = this.spec.stages.find((s) => s.id === stageId);
    return !!stage?.optional && !stage.onFail;
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

  /**
   * An escalated run back at the stage it escalated from, after a person removed the cause. Its
   * history stays. The loop that was spent there counts from zero again: a person said go on, so
   * the next failure sends the run back to be fixed instead of escalating at once (F1).
   */
  resume(state: RunState): Result<RunState, MetatorError> {
    if (state.stage !== "escalated")
      return err(
        MetatorError.usage(
          `the run is ${state.status}; only an escalated run resumes`,
          state.status === "active" ? "It is still going: `metator run drive`." : "Start a new run.",
        ),
      );
    const from = state.context.history.at(-1)?.stage;
    if (!from || !this.spec.stages.some((s) => s.id === from))
      return err(new MetatorError("INVALID_CONFIG", "the run's history does not say where it escalated"));
    const context = structuredClone(state.context);
    const loop = this.spec.stages.find((s) => s.id === from)?.onFail?.loop;
    if (loop !== undefined) context.loops = { ...context.loops, [loop]: 0 };
    return ok({ ...state, stage: from, status: "active", context });
  }

  /**
   * An escalated run given up: it ends as aborted, with the reason in its history at the stage it
   * escalated from (F6). An active run is aborted with the ABORT event instead.
   */
  abandon(state: RunState, reason: string): Result<RunState, MetatorError> {
    if (state.status !== "escalated")
      return err(
        new MetatorError(
          "TRANSITION_DENIED",
          `the run is ${state.status}; only an escalated run is given up`,
        ),
      );
    const from = state.context.history.at(-1)?.stage ?? state.stage;
    const context = structuredClone(state.context);
    context.history = [...context.history, { stage: from, event: "ABORT", detail: reason }];
    return ok({ ...state, stage: "aborted", status: "aborted", context });
  }

  private expected(state: RunState): string {
    if (state.status !== "active") return `The run is ${state.status}; start a new run.`;
    const accepted = this.expects(state);
    return accepted.includes("APPROVE")
      ? `This gate needs a human decision: ${accepted.join(", ")}.`
      : `Send ${accepted.join(", ")}.`;
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
