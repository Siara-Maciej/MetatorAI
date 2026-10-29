import { alg, Graph } from "@dagrejs/graphlib";
import { z } from "zod";
import { matchesAny } from "./glob.ts";
import { defineDocument } from "./versioned.ts";

/**
 * Implementation plans (G4 plan gate, ADR-0035). A plan is a list of file steps; `plan lint`
 * checks it deterministically before any code is written, and `plan scope` turns it into the
 * edit scope the hooks enforce and into shards that can be built independently.
 */
export const PLAN_ACTIONS = ["create", "modify", "delete"] as const;

export const PlanStepSchema = z.strictObject({
  id: z.string().regex(/^S\d+$/, "expected an id like S3"),
  action: z.enum(PLAN_ACTIONS),
  path: z.string().min(1),
  intent: z.string().min(1),
  skill: z.string().optional(),
  /** How the repository already does this (an exemplar from the pattern index). */
  patternSource: z
    .strictObject({
      pattern: z.string().min(1),
      exemplar: z.string().regex(/^[^:]+:\d+$/, "expected <file>:<line>"),
      reason: z.string().min(1),
    })
    .optional(),
  /** A new abstraction instead of an existing pattern: the ADR draft that proposes it. */
  newPatternAdr: z.string().min(1).optional(),
  rules: z.array(z.string()).default([]),
  /** Test files written (by earlier steps) before this step's code. */
  testsFirst: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
});
export type PlanStep = z.output<typeof PlanStepSchema>;

export const PlanSchema = z.strictObject({
  task: z.string().min(1),
  /** Globs the task may touch; every step and test stays inside. */
  scope: z.array(z.string().min(1)).min(1),
  steps: z.array(PlanStepSchema).min(1),
});
export type Plan = z.output<typeof PlanSchema>;

export const PlanDocument = defineDocument("Plan", {
  latest: PlanSchema,
  hint: "Fix the plan; `metator plan schema` prints the JSON Schema.",
});

export interface PlanProblem {
  readonly step?: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/** What `lintPlan` needs to know about the repository. */
export interface PlanFacts {
  readonly files: ReadonlySet<string>;
  /** Pattern id → files that are occurrences of it. */
  readonly patterns: ReadonlyMap<string, ReadonlySet<string>>;
  readonly rules: ReadonlySet<string>;
  /** Internal import edges (importer → imported). */
  readonly imports: readonly { readonly from: string; readonly to: string }[];
  readonly testGlobs: readonly string[];
}

export interface PlanLint {
  readonly steps: number;
  readonly problems: readonly PlanProblem[];
  /** Steps that introduce a new abstraction: they need an accepted ADR before the build. */
  readonly adrRequired: readonly string[];
}

const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function stepGraph(steps: readonly PlanStep[]): Graph {
  const g = new Graph({ directed: true });
  for (const s of steps) g.setNode(s.id);
  for (const s of steps) for (const d of s.dependsOn) if (g.hasNode(d) && d !== s.id) g.setEdge(s.id, d);
  return g;
}

export function lintPlan(plan: Plan, facts: PlanFacts): PlanLint {
  const problems: PlanProblem[] = [];
  const problem = (step: string | undefined, severity: PlanProblem["severity"], message: string) =>
    problems.push({ ...(step ? { step } : {}), severity, message });

  const ids = new Set<string>();
  for (const s of plan.steps) {
    if (ids.has(s.id)) problem(s.id, "error", `duplicate step id ${s.id}`);
    ids.add(s.id);
  }
  const graph = stepGraph(plan.steps);
  for (const s of plan.steps)
    for (const d of s.dependsOn) {
      if (d === s.id) problem(s.id, "error", "depends on itself");
      else if (!ids.has(d)) problem(s.id, "error", `depends on unknown step ${d}`);
    }
  for (const cycle of alg.findCycles(graph))
    problem(undefined, "error", `steps depend on each other: ${cycle.sort().join(", ")}`);
  /** Steps that run before `id` (its transitive dependencies). */
  const before = (id: string) => new Set(alg.preorder(graph, [id]).filter((x) => x !== id));

  const byPath = new Map<string, PlanStep[]>();
  for (const s of plan.steps) byPath.set(s.path, [...(byPath.get(s.path) ?? []), s]);
  for (const [path, steps] of byPath)
    if (steps.length > 1)
      problem(
        steps[1]?.id,
        "warning",
        `${path} is in steps ${steps.map((s) => s.id).join(", ")}; merge them`,
      );
  const created = new Set(plan.steps.filter((s) => s.action === "create").map((s) => s.path));
  const isTest = (path: string) => matchesAny(path, facts.testGlobs);

  for (const s of plan.steps) {
    for (const path of [s.path, ...s.testsFirst])
      if (!matchesAny(path, plan.scope)) problem(s.id, "error", `${path} is outside the task scope`);
    for (const id of s.rules) if (!facts.rules.has(id)) problem(s.id, "error", `unknown rule ${id}`);

    const exists = facts.files.has(s.path);
    if (s.action === "create" && exists)
      problem(s.id, "error", `${s.path} already exists; modify it instead`);
    if (s.action !== "create" && !exists && !created.has(s.path))
      problem(s.id, "error", `${s.path} does not exist`);

    const code = CODE_FILE.test(s.path) && !isTest(s.path);
    if (s.action === "create" && code) {
      if (!s.patternSource && !s.newPatternAdr)
        problem(s.id, "error", "a created file needs patternSource (an exemplar) or newPatternAdr");
      if (s.patternSource && s.newPatternAdr)
        problem(s.id, "error", "use patternSource or newPatternAdr, not both");
      if (s.patternSource && facts.patterns.size === 0) {
        // No pattern catalog (docs/metator/patterns) in this repository: the exemplar must exist.
        const exemplar = s.patternSource.exemplar.replace(/:\d+$/, "");
        if (!facts.files.has(exemplar)) problem(s.id, "error", `exemplar ${exemplar} does not exist`);
        else
          problem(
            s.id,
            "warning",
            `no pattern catalog: ${exemplar} is checked to exist, not to be an occurrence of ${s.patternSource.pattern}`,
          );
      } else if (s.patternSource) {
        const occurrences = facts.patterns.get(s.patternSource.pattern);
        const exemplar = s.patternSource.exemplar.replace(/:\d+$/, "");
        if (!occurrences)
          problem(s.id, "error", `pattern ${s.patternSource.pattern} is not in the pattern index`);
        else if (!occurrences.has(exemplar))
          problem(s.id, "error", `${exemplar} is not an occurrence of pattern ${s.patternSource.pattern}`);
      }
    }

    if (code && s.action !== "delete") {
      if (s.testsFirst.length === 0)
        problem(s.id, "error", "code changes need testsFirst (the tests written before it)");
      const earlier = before(s.id);
      const earlierPaths = new Set(plan.steps.filter((x) => earlier.has(x.id)).map((x) => x.path));
      for (const t of s.testsFirst) {
        if (!isTest(t)) problem(s.id, "error", `${t} is not a test file`);
        else if (!earlierPaths.has(t))
          problem(s.id, "error", `${t} must be written by a step this one depends on`);
      }
    }
  }

  // Dependencies first: a step whose file imports another step's file runs after it. Tests are
  // the exception: they import the code they test and are written before it.
  const stepsOf = (path: string) => byPath.get(path) ?? [];
  for (const { from, to } of facts.imports) {
    if (isTest(from)) continue;
    for (const a of stepsOf(from)) {
      if (a.action === "delete") continue;
      for (const b of stepsOf(to)) {
        if (a.id === b.id || b.action === "delete") continue;
        if (!before(a.id).has(b.id)) problem(a.id, "error", `${from} imports ${to}: depend on ${b.id}`);
      }
    }
  }
  // A deleted file must not leave importers behind.
  for (const s of plan.steps.filter((x) => x.action === "delete")) {
    for (const { from } of facts.imports.filter((e) => e.to === s.path)) {
      if (!stepsOf(from).some((x) => x.action !== "create"))
        problem(s.id, "error", `${from} still imports ${s.path}; modify or delete it in the plan`);
    }
  }

  const adrRequired = plan.steps.filter((s) => s.newPatternAdr).map((s) => s.id);
  for (const id of adrRequired)
    problem(id, "warning", "introduces a new abstraction: the ADR must be accepted first");
  return { steps: plan.steps.length, problems, adrRequired };
}

export const PlanScopeSchema = z.strictObject({
  plan: z.string(),
  /** Exact files the build may edit (step paths and their tests). */
  edit: z.array(z.string()),
  /** Groups of steps with no dependency or import edge between groups. */
  shards: z.array(z.strictObject({ id: z.string(), steps: z.array(z.string()), files: z.array(z.string()) })),
});
export type PlanScope = z.output<typeof PlanScopeSchema>;

export const PlanScopeDocument = defineDocument("PlanScope", { latest: PlanScopeSchema });

export function planScope(
  plan: Plan,
  source: string,
  imports: readonly { readonly from: string; readonly to: string }[],
): PlanScope {
  const files = (s: PlanStep) => [s.path, ...s.testsFirst];
  const edit = [...new Set(plan.steps.flatMap(files))].sort();

  const g = new Graph({ directed: false });
  for (const s of plan.steps) g.setNode(s.id);
  for (const s of plan.steps) for (const d of s.dependsOn) if (g.hasNode(d)) g.setEdge(s.id, d);
  const owners = new Map<string, string[]>();
  for (const s of plan.steps) for (const f of files(s)) owners.set(f, [...(owners.get(f) ?? []), s.id]);
  // Steps on the same file, or on files that import each other, cannot be built apart.
  for (const list of owners.values()) for (const other of list.slice(1)) g.setEdge(list[0] as string, other);
  for (const { from, to } of imports)
    for (const a of owners.get(from) ?? [])
      for (const b of owners.get(to) ?? []) if (a !== b) g.setEdge(a, b);

  const order = new Map(plan.steps.map((s, i) => [s.id, i]));
  const components = alg
    .components(g)
    .map((c) => c.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)))
    .sort((a, b) => (order.get(a[0] as string) ?? 0) - (order.get(b[0] as string) ?? 0));
  const shards = components.map((steps, i) => ({
    id: `shard-${i + 1}`,
    steps,
    files: [...new Set(plan.steps.filter((s) => steps.includes(s.id)).flatMap(files))].sort(),
  }));
  return { plan: source, edit, shards };
}
