import { z } from "zod";
import { type ArchitectureInput, type ArchitectureReport, analyzeArchitecture } from "./architecture.ts";
import { applyMoves, checkMoves, type Move, MoveSchema, simulateMoves } from "./architecture-moves.ts";
import { defineDocument } from "./versioned.ts";

/**
 * A refactor plan (H5, ADR-0065): moves with the reason each one exists (the responsibility it
 * puts right, with citations), in waves. The tool, not the author, writes each move's effect by
 * simulation; lint proves the plan reaches its goal without new errors; a person approves it,
 * and the approval covers exactly the moves that were approved (a digest). Executed as W3 runs.
 * `metator/arch/plans/<id>.yml`.
 */
export const PLAN_GOALS = ["no-cycles", "no-errors", "fewer-violations"] as const;
export type PlanGoal = (typeof PLAN_GOALS)[number];

const EffectSchema = z.strictObject({
  scoreBefore: z.number().int(),
  scoreAfter: z.number().int(),
  fixed: z.array(z.string()),
  added: z.array(z.string()),
  rewrites: z.number().int().nonnegative(),
  declared: z.array(z.strictObject({ package: z.string(), dependency: z.string() })),
});

const Summary = z.strictObject({
  cycles: z.number().int(),
  errors: z.number().int(),
  warnings: z.number().int(),
  score: z.number().int(),
});

const PlanMoveSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a short id such as m1 or split-kit"),
  move: MoveSchema,
  /** Why the move is right: the responsibility it puts in its place. */
  why: z.string().min(1),
  /** `path` or `path:line` the reason rests on (code, module cards, ADRs). */
  citations: z.array(z.string().min(1)).min(1, "cite the code or card the reason rests on"),
  /** Moves of one wave run in parallel; a wave starts when the one before is done. */
  wave: z.number().int().positive(),
  status: z.enum(["pending", "running", "done", "blocked"]).default("pending"),
  /** The W3 run that executes it (`arch plan run`). */
  run: z.string().optional(),
  note: z.string().optional(),
  /** Written by `arch plan simulate`, never by hand. */
  effect: EffectSchema.optional(),
});
export type PlanMove = z.output<typeof PlanMoveSchema>;

export const RefactorPlanSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  goal: z.enum(PLAN_GOALS),
  status: z.enum(["draft", "approved", "running", "done"]).default("draft"),
  createdBy: z.string().optional(),
  /** Who approved which moves (their digest) and when. */
  approval: z.strictObject({ by: z.string().min(1), at: z.string(), digest: z.string() }).optional(),
  moves: z.array(PlanMoveSchema).default([]),
  /** The whole plan simulated: the repository before and after every wave (`arch plan simulate`). */
  result: z.strictObject({ before: Summary, after: Summary }).optional(),
});
export type RefactorPlan = z.output<typeof RefactorPlanSchema>;

export const RefactorPlanDocument = defineDocument("RefactorPlan", {
  latest: RefactorPlanSchema,
  errorCode: "INVALID_CONFIG",
  hint: "`metator arch plan schema` prints the format; `metator arch plan new` starts one.",
});

/** A plan id from its title: lower case, words joined by dashes, at most 48 characters. */
export function planId(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "plan";
}

/** A canonical text of plain data (keys sorted): for digests and equality, not a file format. */
export function canonical(value: unknown): string {
  if (value === undefined) return "~";
  if (value === null || typeof value !== "object")
    return typeof value === "string" ? `"${value.replace(/["\\]/g, "\\$&")}"` : String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  return `{${entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${canonical(k)}:${canonical(v)}`)
    .join(",")}}`;
}

/** FNV-1a over the moves as data: what an approval covers. */
export function planDigest(plan: Pick<RefactorPlan, "moves">): string {
  const text = canonical(plan.moves.map((m) => ({ id: m.id, move: m.move, wave: m.wave })));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Moves in the order they run: wave by wave, in file order within a wave. */
export const orderedMoves = (plan: Pick<RefactorPlan, "moves">): PlanMove[] =>
  plan.moves
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.wave - b.m.wave || a.i - b.i)
    .map((x) => x.m);

const summary = (r: ArchitectureReport) => ({
  cycles: r.summary.cycles,
  errors: r.summary.errors,
  warnings: r.summary.warnings,
  score: r.summary.score,
});

/** The plan with each move's effect (relative to the state before it) and the whole result. */
export function simulatePlan(input: ArchitectureInput, plan: RefactorPlan): RefactorPlan {
  let state = input;
  let report = analyzeArchitecture(input);
  const first = report;
  const effects = new Map<string, z.output<typeof EffectSchema>>();
  for (const pm of orderedMoves(plan)) {
    const s = simulateMoves(state, [pm.move], report);
    effects.set(pm.id, {
      scoreBefore: s.effect.before.score,
      scoreAfter: s.effect.after.score,
      fixed: [...s.effect.fixed],
      added: s.effect.added.map((v) => v.id),
      rewrites: s.effect.rewrites,
      declared: [...s.effect.declared],
    });
    state = s.input;
    report = s.report;
  }
  return {
    ...plan,
    moves: plan.moves.map((m) => {
      const effect = effects.get(m.id);
      return effect ? { ...m, effect } : m;
    }),
    result: { before: summary(first), after: summary(report) },
  };
}

export interface RefactorPlanProblem {
  readonly severity: "error" | "warning";
  readonly move?: string;
  readonly message: string;
}

/** Whether a goal holds after the plan, given the report before it. */
export function goalMet(
  goal: PlanGoal,
  before: ArchitectureReport["summary"],
  after: ArchitectureReport["summary"],
): boolean {
  if (goal === "no-cycles") return after.cycles === 0;
  if (goal === "no-errors") return after.errors === 0;
  return after.errors + after.warnings < before.errors + before.warnings;
}

/**
 * Plan lint (E1): ids unique, waves 1, 2, … without gaps, every move possible where it runs,
 * citations that exist, effects written by the current simulation, no error the plan adds, the
 * goal reached, and an approval that still covers the moves.
 */
export function lintRefactorPlan(
  plan: RefactorPlan,
  input: ArchitectureInput,
  exists: (path: string) => boolean,
): RefactorPlanProblem[] {
  const problems: RefactorPlanProblem[] = [];
  const error = (message: string, move?: string) =>
    problems.push({ severity: "error", message, ...(move ? { move } : {}) });
  const warn = (message: string, move?: string) =>
    problems.push({ severity: "warning", message, ...(move ? { move } : {}) });

  if (plan.approval && plan.approval.digest !== planDigest(plan))
    error(`the moves changed after ${plan.approval.by} approved them; approve the plan again`);
  if (plan.moves.length === 0) error("the plan has no moves");
  const ids = plan.moves.map((m) => m.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i)))
    error(`two moves are named ${id}`, id);
  const waves = [...new Set(plan.moves.map((m) => m.wave))].sort((a, b) => a - b);
  waves.forEach((w, i) => {
    if (w !== i + 1)
      error(`waves must be 1, 2, 3 … without gaps; wave ${w} follows ${waves[i - 1] ?? "nothing"}`);
  });
  for (const m of plan.moves)
    for (const c of m.citations)
      if (!exists(c.replace(/:\d+(-\d+)?$/, ""))) error(`${c} does not exist`, m.id);

  // Every move must be possible on the state the moves before it leave.
  let state = input;
  for (const pm of orderedMoves(plan)) {
    for (const p of checkMoves(state, [pm.move])) error(p, pm.id);
    state = applyMoves(state, [pm.move]).input;
  }
  if (problems.some((p) => p.severity === "error")) return problems;

  const simulated = simulatePlan(input, plan);
  for (const m of simulated.moves) {
    const written = plan.moves.find((x) => x.id === m.id)?.effect;
    if (canonical(written) !== canonical(m.effect))
      error("the effect is missing or out of date: run `metator arch plan simulate`", m.id);
    else if (m.effect && m.effect.fixed.length === 0 && m.effect.scoreAfter <= m.effect.scoreBefore)
      warn("the move fixes nothing on its own", m.id);
  }
  if (canonical(plan.result) !== canonical(simulated.result) && !problems.some((p) => p.move))
    error("the result is missing or out of date: run `metator arch plan simulate`");

  const before = analyzeArchitecture(input);
  const after = analyzeArchitecture(state);
  const beforeIds = new Set(before.violations.filter((v) => !v.exception).map((v) => v.id));
  for (const v of after.violations)
    if (!v.exception && v.severity === "error" && !beforeIds.has(v.id))
      error(`the plan adds ${v.id}: ${v.message}`);
  if (!goalMet(plan.goal, before.summary, after.summary))
    error(
      `the plan does not reach its goal ${plan.goal}: ${after.summary.cycles} cycle(s), ${after.summary.errors} error(s), ${after.summary.warnings} warning(s) after it`,
    );
  return problems;
}

/** A one-line description of a move, for run tasks and reports. */
export function describeMove(m: Move): string {
  switch (m.type) {
    case "move":
      return `Move ${m.files.join(", ")} to ${m.to}`;
    case "merge":
      return `Merge ${m.from} into ${m.into}`;
    case "extract":
      return `Extract ${m.files.join(", ")} into a new package ${m.package.name} (${m.package.dir})`;
    case "invert":
      return `Invert the dependency ${m.from} → ${m.to}: a port in ${m.from}, its implementation in ${m.to}`;
    case "declare":
      return `Declare ${m.dependency} in ${m.package}`;
  }
}

/** The moves `arch plan run` starts next: the pending ones of the first wave not done. */
export function nextWave(plan: RefactorPlan): { wave: number; moves: PlanMove[] } | undefined {
  for (const wave of [...new Set(plan.moves.map((m) => m.wave))].sort((a, b) => a - b)) {
    const moves = plan.moves.filter((m) => m.wave === wave);
    if (moves.every((m) => m.status === "done")) continue;
    return { wave, moves: moves.filter((m) => m.status === "pending") };
  }
  return undefined;
}

/** The prompt for mt-arch-planner: the goal, where the facts are and what to write. */
export function plannerPrompt(input: {
  readonly plan: string;
  readonly goal: PlanGoal;
  readonly report: string;
}): string {
  return [
    `Plan a refactor of this repository's packages with the goal ${input.goal}.`,
    `The architecture report is ${input.report} (JSON next to it); the plan to fill is ${input.plan}.`,
    "Add moves to the plan: each with an id, the move, why it puts a responsibility in its place, citations and a wave.",
    "Before you add a move, try it: `metator arch simulate …`. Then run `metator arch plan simulate` and `metator arch plan lint` until lint is clean.",
    "Do not approve the plan and do not change code: a person approves, and `metator arch plan run` executes it.",
  ].join("\n");
}
