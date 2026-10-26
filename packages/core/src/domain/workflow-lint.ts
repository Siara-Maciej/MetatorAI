import type { WorkflowSpec } from "./workflow-spec.ts";

/**
 * `workflow lint` (ADR-0042): a workflow answers all 16 questions of the anatomy
 * (02-workflows §1), its owners and critics exist, and its limits are sane. Loops need no check
 * here: the schema rejects a loop back without its limit.
 */
export const ANATOMY = [
  "entry",
  "input",
  "preconditions",
  "stages",
  "artifacts",
  "gates",
  "parallelism",
  "loops",
  "escalation",
  "autonomy",
  "permissions",
  "done",
  "recovery",
  "resume",
  "telemetry",
  "report",
] as const;
export type AnatomySection = (typeof ANATOMY)[number];

export interface WorkflowProblem {
  readonly section?: AnatomySection;
  readonly stage?: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface WorkflowLintContext {
  readonly agents: ReadonlySet<string>;
  readonly skills: ReadonlySet<string>;
  /** Most workers a stage may run at once (02-workflows: max 6). */
  readonly maxParallel: number;
}

const owners = (o: string | readonly string[] | undefined) =>
  o === undefined ? [] : typeof o === "string" ? [o] : o;

export function lintWorkflow(spec: WorkflowSpec, ctx: WorkflowLintContext): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const missing = (section: AnatomySection, what: string) =>
    problems.push({ section, severity: "error", message: `${section}: ${what}` });

  if (!spec.entry || (spec.entry.prompt === undefined && !spec.entry.ci && spec.entry.cron === undefined))
    missing("entry", "say how it starts (entry.prompt, entry.ci or entry.cron)");
  if (!spec.input) missing("input", "declare the input contract (input.oneOf / required / optional)");
  if (!spec.preconditions)
    missing("preconditions", "list what must hold before it starts (an empty list is a choice)");
  const working = spec.stages.filter((s) => !s.hitl);
  for (const s of working)
    if (owners(s.owner).length === 0 && !s.parallel)
      problems.push({
        section: "stages",
        stage: s.id,
        severity: "error",
        message: `stages: ${s.id} has no owner`,
      });
  if (!spec.stages.some((s) => (s.produces ?? []).length > 0))
    missing("artifacts", "no stage produces an artifact");
  if (!spec.stages.some((s) => s.gate || s.hitl))
    missing("gates", "no stage has a gate (script, llm) or a human gate");
  if (!spec.limits) missing("parallelism", "set limits.parallel");
  else if (spec.limits.parallel > ctx.maxParallel)
    problems.push({
      section: "parallelism",
      severity: "error",
      message: `parallelism: limits.parallel ${spec.limits.parallel} exceeds ${ctx.maxParallel}`,
    });
  for (const s of spec.stages)
    if ((s.parallel ?? []).length > (spec.limits?.parallel ?? ctx.maxParallel))
      problems.push({
        section: "parallelism",
        stage: s.id,
        severity: "error",
        message: `parallelism: ${s.id} starts more workers than limits.parallel`,
      });
  if (!spec.escalation)
    missing("escalation", "say what happens when a loop is exhausted and when the task is ambiguous");
  if (!spec.autonomy) missing("autonomy", "list the autonomy levels it supports");
  if (!spec.permissions)
    missing("permissions", "say what may be edited and which external actions need approval");
  if (!spec.done) missing("done", "give the definition of done");
  if (!spec.recovery) missing("recovery", "say what happens when tests, a hook or a tool fail");
  if (!spec.resume) missing("resume", "say how a run continues after a break or a compaction");
  if (!spec.telemetry) missing("telemetry", "list what is measured");
  if (!spec.report) missing("report", "describe the final report");

  for (const s of spec.stages) {
    for (const o of [...owners(s.owner), ...(s.parallel ?? []), ...(s.gate?.llm ? [s.gate.llm] : [])]) {
      if (o.startsWith("script:")) continue;
      const known = o.startsWith("skill:") ? ctx.skills.has(o.slice("skill:".length)) : ctx.agents.has(o);
      if (!known)
        problems.push({
          stage: s.id,
          severity: "error",
          message: `${s.id}: ${o} is not a canonical ${o.startsWith("skill:") ? "skill" : "agent"}`,
        });
    }
    if (s.skipAt && !s.hitl)
      problems.push({
        stage: s.id,
        severity: "error",
        message: `${s.id}: skipAt only applies to a human gate (hitl)`,
      });
    if (s.skipAt && s.neverSkip)
      problems.push({
        stage: s.id,
        severity: "error",
        message: `${s.id}: a stage marked neverSkip cannot be skipped`,
      });
    for (const level of s.skipAt ?? [])
      if (spec.autonomy && !spec.autonomy.includes(level))
        problems.push({
          stage: s.id,
          severity: "warning",
          message: `${s.id}: skips at ${level}, which the workflow does not support`,
        });
  }
  return problems;
}
