import type { WorkerResult } from "./conductor.ts";
import type { Question, RunActivity } from "./drive.ts";
import type { GateReport } from "./gate.ts";
import { type StageProgress, stageProgress } from "./overview.ts";
import type { Plan, PlanStep } from "./plan.ts";

/**
 * The plan board (S2, design/13 §2): where a run stands and what is left, as one projection of
 * the run's own files: the workflow's stages with who worked them and when, the plan's steps
 * with their live state, the workers in their panes, what waits for a person, the artifacts and
 * gates, and the last events. Nothing here is written by a model; nothing is stored: it is
 * computed on request from the record, the plan, the results, the activity and the layout.
 */
export type StepState = "todo" | "in-progress" | "done" | "blocked";

export interface BoardStep {
  readonly id: string;
  readonly action: PlanStep["action"];
  readonly path: string;
  readonly intent: string;
  readonly state: StepState;
  readonly testsFirst: readonly string[];
  readonly rules: readonly string[];
  readonly exemplar?: string | undefined;
  readonly dependsOn: readonly string[];
  /** The worker whose result or edits moved the step, with its pane when it is still open. */
  readonly worker?: { readonly name: string; readonly paneId?: string | undefined } | undefined;
  /** What says so: the worker's result, an edit in the activity, or nothing yet. */
  readonly evidence?: string | undefined;
}

export interface BoardStage extends StageProgress {
  /** Who the workflow gives the stage to (an agent, a skill, a script, or several). */
  readonly owners: readonly string[];
  /** The agents the activity saw working in it. */
  readonly workedBy: readonly string[];
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  /** How a gate stage ended: PASS, FAIL, APPROVE, REJECT. */
  readonly verdict?: string | undefined;
}

export interface BoardWorker {
  readonly name: string;
  readonly stage: string;
  readonly agent: string;
  readonly paneId: string;
  readonly alive: boolean;
  readonly state?: string | undefined;
  readonly result?: Pick<WorkerResult, "status" | "summary" | "at"> | undefined;
}

export interface BoardArtifact {
  readonly name: string;
  readonly present: boolean;
  /** The stage that declares it in `produces`. */
  readonly stage?: string | undefined;
}

export interface BoardGate {
  readonly gate: GateReport["gate"];
  readonly passed: boolean;
  readonly at: string;
  readonly steps: readonly { readonly id: string; readonly ok: boolean }[];
}

export interface PlanBoardView {
  readonly runId: string;
  readonly task: string;
  readonly workflow: string;
  readonly status: string;
  readonly stage: string;
  readonly stages: readonly BoardStage[];
  readonly plan?:
    | { readonly scope: readonly string[]; readonly steps: readonly BoardStep[]; readonly done: number }
    | undefined;
  readonly workers: readonly BoardWorker[];
  /** Open questions, the oldest first: what a person has to decide. */
  readonly waiting: readonly Question[];
  readonly artifacts: readonly BoardArtifact[];
  readonly gates: readonly BoardGate[];
  /** What comes next: the stages after the current one, with their owners. */
  readonly next: readonly { readonly id: string; readonly owners: readonly string[] }[];
  /** The last events, the oldest first. */
  readonly timeline: readonly RunActivity[];
}

export interface PlanBoardInput {
  readonly runId: string;
  readonly task: string;
  readonly workflow: string;
  readonly status: string;
  readonly stage: string;
  readonly history: readonly {
    readonly stage: string;
    readonly event: string;
    readonly detail?: string | undefined;
  }[];
  readonly stages: readonly {
    readonly id: string;
    readonly hitl?: boolean | undefined;
    readonly owners: readonly string[];
    readonly produces: readonly string[];
  }[];
  readonly plan?: Plan | undefined;
  readonly results: readonly WorkerResult[];
  readonly workers: readonly BoardWorker[];
  readonly questions: readonly Question[];
  readonly activity: readonly RunActivity[];
  /** Run-directory files present (relative to the run directory). */
  readonly files: readonly string[];
  readonly gates: readonly GateReport[];
  /** How many events the timeline keeps. */
  readonly timelineLength?: number;
}

/** Always shown, whether or not a stage declares them. */
const KNOWN_ARTIFACTS = [
  "task.md",
  "analysis.json",
  "research.json",
  "rulepack.md",
  "plan.json",
  "plan-scope.json",
  "plan-review.md",
  "build-log.md",
  "verdict.json",
];

export function planBoardOf(input: PlanBoardInput): PlanBoardView {
  const open = input.questions.filter((q) => !q.answer);
  const progress = stageProgress(input.stages, input.stage, input.status, open.length);
  const stages: BoardStage[] = progress.map((p, i) => {
    const spec = input.stages[i];
    const entries = input.activity.filter((a) => a.stage === p.id);
    const workedBy = [...new Set(entries.filter((a) => a.agent).map((a) => a.agent as string))];
    const started = entries.find((a) => a.type === "stage" || a.type === "agent")?.at ?? entries[0]?.at;
    const after = input.activity.filter((a) => a.at > (started ?? "") && a.stage && a.stage !== p.id);
    const ended = p.state === "done" ? (after[0]?.at ?? entries.at(-1)?.at) : undefined;
    const verdict = [...input.history].reverse().find((h) => h.stage === p.id)?.event;
    return {
      ...p,
      owners: spec?.owners ?? [],
      workedBy,
      startedAt: started,
      endedAt: ended,
      ...(verdict ? { verdict } : {}),
    };
  });
  const steps = input.plan ? input.plan.steps.map((s) => stepOf(s, input)) : [];
  const declared = new Map<string, string>();
  for (const s of input.stages) for (const a of s.produces) declared.set(a, s.id);
  const names = [
    ...new Set([...KNOWN_ARTIFACTS, ...declared.keys(), ...input.files.filter((f) => !f.includes("/"))]),
  ];
  const artifacts: BoardArtifact[] = names
    .filter(
      (n) =>
        !["state.json", "log.md", "activity.jsonl", "usage.jsonl", "seen.json", "driver.json"].includes(n),
    )
    .map((name) => ({ name, present: input.files.includes(name), stage: declared.get(name) }));
  const at = input.stages.findIndex((s) => s.id === input.stage);
  const next =
    input.status === "done" ? [] : input.stages.slice(at + 1).map((s) => ({ id: s.id, owners: s.owners }));
  const gates: BoardGate[] = [...input.gates]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((g) => ({
      gate: g.gate,
      passed: g.passed,
      at: g.startedAt,
      steps: g.steps.map((s) => ({ id: s.id, ok: s.status === "pass" || s.status === "skipped" })),
    }));
  const length = input.timelineLength ?? 30;
  return {
    runId: input.runId,
    task: input.task,
    workflow: input.workflow,
    status: input.status,
    stage: input.stage,
    stages,
    ...(input.plan
      ? { plan: { scope: input.plan.scope, steps, done: steps.filter((s) => s.state === "done").length } }
      : {}),
    workers: input.workers,
    waiting: [...open].sort((a, b) => a.askedAt.localeCompare(b.askedAt)),
    artifacts,
    gates,
    next,
    timeline: input.activity.slice(-length),
  };
}

/**
 * A step's state from what the files say: done when a worker's result names its path (or the
 * step), in progress when a worker edited the path (a tool call in the activity) or a live worker
 * of the plan's stage is on the first step not done, blocked when a worker reported so after
 * touching it, todo otherwise. The order of the steps gives the "first not done".
 */
function stepOf(step: PlanStep, input: PlanBoardInput): BoardStep {
  const base: BoardStep = {
    id: step.id,
    action: step.action,
    path: step.path,
    intent: step.intent,
    state: "todo",
    testsFirst: step.testsFirst,
    rules: step.rules,
    exemplar: step.patternSource?.exemplar,
    dependsOn: step.dependsOn,
  };
  const mentions = (text: string) => text.includes(step.path) || new RegExp(`\\b${step.id}\\b`).test(text);
  const done = input.results.find(
    (r) => r.status === "done" && (r.artifacts.some(mentions) || mentions(r.summary)),
  );
  if (done)
    return {
      ...base,
      state: "done",
      worker: workerRef(done.worker, input),
      evidence: `${done.worker}: ${done.summary}`,
    };
  const blocked = input.results.find(
    (r) =>
      r.status !== "done" &&
      (r.artifacts.some(mentions) || mentions(r.summary) || mentions(r.question ?? "")),
  );
  if (blocked)
    return {
      ...base,
      state: "blocked",
      worker: workerRef(blocked.worker, input),
      evidence: `${blocked.worker}: ${blocked.question ?? blocked.summary}`,
    };
  const edit = [...input.activity].reverse().find((a) => a.type === "tool" && a.text.includes(step.path));
  if (edit) {
    const worker = edit.agent
      ? input.workers.find((w) => w.agent === edit.agent || w.name === edit.agent)
      : undefined;
    return {
      ...base,
      state: "in-progress",
      ...(worker ? { worker: { name: worker.name, paneId: worker.paneId } } : {}),
      evidence: edit.text,
    };
  }
  return base;
}

const workerRef = (name: string, input: PlanBoardInput): BoardStep["worker"] => {
  const w = input.workers.find((x) => x.name === name);
  return { name, paneId: w?.paneId };
};

/** After the evidence, the first todo step of a stage with a live worker is the one in progress. */
export function withLiveWorker(board: PlanBoardView): PlanBoardView {
  if (!board.plan) return board;
  const live = board.workers.find((w) => w.alive && !w.result);
  if (!live) return board;
  if (board.plan.steps.some((s) => s.state === "in-progress")) return board;
  const first = board.plan.steps.findIndex((s) => s.state === "todo");
  if (first < 0) return board;
  const steps = board.plan.steps.map((s, i) =>
    i === first
      ? {
          ...s,
          state: "in-progress" as const,
          worker: { name: live.name, paneId: live.paneId },
          evidence: `${live.name} works in ${live.paneId}`,
        }
      : s,
  );
  return { ...board, plan: { ...board.plan, steps } };
}
