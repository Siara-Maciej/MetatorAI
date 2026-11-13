import { consequencesOf, type DecisionCard, sinceLastAnswer } from "../domain/drive.ts";
import { GateReportDocument } from "../domain/gate.ts";
import { PlanScopeDocument } from "../domain/plan.ts";
import { isRunBookkeeping } from "../domain/run-record.ts";
import type { StageSpec } from "../domain/workflow-spec.ts";
import type { ReadonlyFileSystem } from "../ports/index.ts";
import { parseDocumentText } from "./document-io.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";

/** What a decision card is read from: the run directory, the record, the activity, the gate reports. */
export interface DecisionCardSources {
  readonly fs: ReadonlyFileSystem;
  readonly repo: Pick<RunRepository, "runDir" | "load">;
  readonly journal: Pick<RunJournal, "activity">;
  /** Where gate reports are (`paths.gates`); the default when absent. */
  readonly gatesDir?: string | undefined;
}

/** Where the run stands when the question is asked. */
export interface DecisionCardContext {
  readonly runId: string;
  readonly task: string;
  readonly stage: StageSpec;
  /** Stages the run passed, in order (each once). */
  readonly done: readonly string[];
  /** The workflow's stages, the loops used so far and their limits: what each option would do. */
  readonly stages: readonly StageSpec[];
  readonly loops: Readonly<Record<string, number>>;
  readonly loopLimits: Readonly<Record<string, number>>;
  readonly children: readonly string[];
  /** The worktree's port block, when the run has one. */
  readonly ports?: { readonly from: number; readonly count: number };
}

/**
 * The decision card of a question (P4, D5): the task, the stages passed, the artifacts written so
 * far, what the caller knows of the recommended option and whether it can be taken back, and
 * what the record, the activity, the gate reports and the plan scope say besides.
 */
export async function decisionCard(
  d: DecisionCardSources,
  ctx: DecisionCardContext,
  known: { readonly recommended?: string; readonly reversible: boolean },
): Promise<DecisionCard> {
  const dir = d.repo.runDir(ctx.runId);
  const files = await d.fs.glob([`${dir}/*`]);
  const artifacts = files.map((f) => f.slice(dir.length + 1)).filter((f) => !isRunBookkeeping(f));
  const activity = await d.journal.activity(ctx.runId);
  const soFar = activity.isOk() ? sinceLastAnswer(activity.value) : [];
  const evidence = await gateEvidence(d);
  const blastRadius = await blastRadiusOf(d, dir);
  const group = await groupOf(d, ctx.runId);
  return {
    task: ctx.task,
    done: [...ctx.done],
    artifacts,
    ...known,
    soFar,
    evidence,
    consequences: consequencesOf(ctx.stage, ctx.stages, ctx.loops, ctx.loopLimits),
    ...(blastRadius ? { blastRadius } : {}),
    costOfDelay: costOfDelay(ctx),
    ...(group ? { group } : {}),
  };
}

/** Each gate report as one line: the gate, whether it passed, every step's outcome. */
async function gateEvidence(d: DecisionCardSources): Promise<string[]> {
  const out: string[] = [];
  for (const file of await d.fs.glob([`${d.gatesDir ?? ".metator/gates"}/*.json`])) {
    const text = await d.fs.read(file);
    if (text.isErr()) continue;
    const report = parseDocumentText(text.value, file, GateReportDocument, "json");
    if (report.isErr()) continue;
    const steps = report.value.steps.map(
      (s) => `${s.id} ${s.status === "pass" ? "✓" : s.status === "fail" ? "✗" : s.status}`,
    );
    out.push(`${report.value.gate}: ${report.value.passed ? "passed" : "failed"} (${steps.join(", ")})`);
  }
  return out;
}

/** The plan's files, and the top-level areas (first path segment) they are in. */
async function blastRadiusOf(d: DecisionCardSources, dir: string): Promise<DecisionCard["blastRadius"]> {
  const file = `${dir}/plan-scope.json`;
  if (!(await d.fs.exists(file))) return undefined;
  const text = await d.fs.read(file);
  if (text.isErr()) return undefined;
  const scope = parseDocumentText(text.value, file, PlanScopeDocument, "json");
  if (scope.isErr()) return undefined;
  const areas = [...new Set(scope.value.edit.map((f) => f.split("/")[0] ?? f))].sort();
  return { files: scope.value.edit.length, areas };
}

/** What waiting costs: ports the worktree holds, loops used, children waiting on this run. */
export function costOfDelay(
  ctx: Pick<DecisionCardContext, "ports" | "loops" | "loopLimits" | "children">,
): string[] {
  const out: string[] = [];
  if (ctx.ports)
    out.push(`its worktree keeps ports ${ctx.ports.from}–${ctx.ports.from + ctx.ports.count - 1} busy`);
  for (const [loop, used] of Object.entries(ctx.loops))
    if (used > 0) out.push(`loop ${loop}: ${used} of ${ctx.loopLimits[loop] ?? "?"} used`);
  if (ctx.children.length > 0) out.push(`${ctx.children.length} child run(s) depend on this run`);
  return out;
}

/** The feature group: the parent run, and this run's place among its children. */
async function groupOf(d: DecisionCardSources, runId: string): Promise<DecisionCard["group"]> {
  const record = await d.repo.load(runId);
  if (record.isErr() || !record.value.parent) return undefined;
  const parent = await d.repo.load(record.value.parent);
  const siblings = parent.isOk() ? (parent.value.children ?? []) : [];
  const at = siblings.indexOf(runId);
  return { parent: record.value.parent, step: at >= 0 ? at + 1 : 1, of: Math.max(siblings.length, 1) };
}
