import { MetatorError } from "../domain/errors.ts";
import {
  type BuildProgress,
  BuildProgressDocument,
  lintPlan,
  type Plan,
  PlanDocument,
  type PlanLint,
  type PlanScope,
  PlanScopeDocument,
  planScope,
} from "../domain/plan.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import { loadDocument, readDocument, writeDocument } from "./document-io.ts";
import type { BuildImportGraph } from "./import-graph.ts";
import type { ScanPatterns } from "./patterns.ts";
import type { RuleCatalog } from "./rules.ts";
import type { RunAffectedTests } from "./test-affected.ts";

type ImportEdges = readonly { readonly from: string; readonly to: string }[];

const readPlan = (fs: FileSystem, file: string): Promise<Result<Plan, MetatorError>> =>
  loadDocument(fs, file, PlanDocument, "json");

async function internalImports(
  graph: Pick<BuildImportGraph, "execute">,
): Promise<Result<ImportEdges, MetatorError>> {
  const report = await graph.execute();
  if (report.isErr()) return err(report.error);
  return ok(report.value.edges.filter((e) => e.kind !== "external").map(({ from, to }) => ({ from, to })));
}

/**
 * `plan lint <plan.json>` (G4 plan gate, ADR-0035): checks a plan against the repository
 * (files, pattern index, rule canon, import graph) before any code is written.
 */
export class LintPlan {
  constructor(
    private readonly fs: FileSystem,
    private readonly patterns: Pick<ScanPatterns, "execute">,
    private readonly rules: Pick<RuleCatalog, "scan">,
    private readonly graph: Pick<BuildImportGraph, "execute">,
    private readonly testGlobs: readonly string[],
  ) {}

  async execute(input: { readonly file: string }): Promise<Result<PlanLint, MetatorError>> {
    const plan = await readPlan(this.fs, input.file);
    if (plan.isErr()) return err(plan.error);
    return this.check(plan.value);
  }

  /** The same checks for a plan that is not a file yet (a person's edit in the app). */
  async check(plan: Plan): Promise<Result<PlanLint, MetatorError>> {
    const scan = await this.patterns.execute();
    if (scan.isErr()) return err(scan.error);
    const imports = await internalImports(this.graph);
    if (imports.isErr()) return err(imports.error);

    const files = new Set<string>();
    const named = plan.steps.flatMap((s) => [
      s.path,
      ...(s.patternSource ? [s.patternSource.exemplar.replace(/:\d+$/, "")] : []),
    ]);
    for (const path of new Set(named)) if (await this.fs.exists(path)) files.add(path);
    return ok(
      lintPlan(plan, {
        files,
        patterns: new Map(scan.value.patterns.map((p) => [p.id, new Set(p.occurrences.map((o) => o.file))])),
        rules: new Set((await this.rules.scan()).rules.map((r) => r.rule.id)),
        imports: imports.value,
        testGlobs: this.testGlobs,
        hasTests: (await this.fs.glob(this.testGlobs)).some((f) => !f.includes("node_modules/")),
      }),
    );
  }
}

/**
 * `plan scope <plan.json>`: writes the edit scope and independent shards next to the plan; with
 * `dryRun` it only computes them (the MCP tool, which never writes).
 */
export class ScopePlan {
  constructor(
    private readonly fs: FileSystem,
    private readonly graph: Pick<BuildImportGraph, "execute">,
  ) {}

  async execute(input: {
    readonly file: string;
    readonly out?: string;
    readonly dryRun?: boolean;
  }): Promise<Result<PlanScope & { readonly output?: string }, MetatorError>> {
    const plan = await readPlan(this.fs, input.file);
    if (plan.isErr()) return err(plan.error);
    const imports = await internalImports(this.graph);
    if (imports.isErr()) return err(imports.error);
    const scope = planScope(plan.value, input.file, imports.value);
    if (input.dryRun) return ok(scope);
    const dir = input.file.includes("/") ? input.file.slice(0, input.file.lastIndexOf("/")) : ".";
    const output = input.out ?? `${dir}/plan-scope.json`;
    const saved = await writeDocument(this.fs, output, PlanScopeDocument, scope, "json");
    if (saved.isErr()) return err(saved.error);
    return ok({ ...scope, output });
  }
}

const dirOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".");
const progressFile = (planFile: string) => `${dirOf(planFile)}/build-progress.json`;

async function readProgress(fs: FileSystem, planFile: string): Promise<Result<BuildProgress, MetatorError>> {
  const read = await readDocument(fs, progressFile(planFile), BuildProgressDocument, "json");
  return read.map((progress) => progress ?? { plan: planFile, steps: {} });
}

export interface StepCheck {
  readonly step: string;
  readonly passed: boolean;
  readonly tests: readonly string[];
  readonly command: readonly string[] | null;
  readonly exitCode: number | null;
  readonly output?: string;
  readonly progress: string;
}

/**
 * `plan done <plan.json> <step>` (Etap 3): the checkpoint of one step. Its file and the tests it
 * was written against go through `test affected`; the result, green or red, is recorded in
 * `build-progress.json` next to the plan. A step whose dependencies have not passed is refused
 * before anything runs, so a step cannot be called done on top of a broken one.
 */
export class CheckPlanStep {
  constructor(
    private readonly fs: FileSystem,
    private readonly tests: Pick<RunAffectedTests, "execute">,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly file: string;
    readonly step: string;
    readonly script?: string;
    readonly timeoutMs?: number;
  }): Promise<Result<StepCheck, MetatorError>> {
    const plan = await readPlan(this.fs, input.file);
    if (plan.isErr()) return err(plan.error);
    const step = plan.value.steps.find((s) => s.id === input.step);
    if (!step)
      return err(
        MetatorError.notFound(
          `step ${input.step} in ${input.file} (steps: ${plan.value.steps.map((s) => s.id).join(", ")})`,
        ),
      );
    const progress = await readProgress(this.fs, input.file);
    if (progress.isErr()) return err(progress.error);
    const open = step.dependsOn.filter((d) => progress.value.steps[d]?.passed !== true);
    if (open.length > 0)
      return err(
        new MetatorError(
          "CHECK_FAILED",
          `${step.id} depends on ${open.join(", ")}, which has not passed yet`,
          { hint: `Run \`metator plan done ${input.file} ${open[0]}\` first.` },
        ),
      );
    const run = await this.tests.execute({
      changed: [step.path, ...step.testsFirst],
      script: input.script ?? "test",
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    if (run.isErr()) return err(run.error);
    const result = {
      passed: run.value.passed,
      at: this.clock.now().toISOString(),
      tests: [...run.value.tests],
      command: run.value.command ? [...run.value.command] : null,
      exitCode: run.value.exitCode,
      ...(run.value.output !== undefined ? { output: run.value.output } : {}),
    };
    const next = { plan: input.file, steps: { ...progress.value.steps, [step.id]: result } };
    const saved = await writeDocument(this.fs, progressFile(input.file), BuildProgressDocument, next, "json");
    if (saved.isErr()) return err(saved.error);
    const passed = plan.value.steps.filter((s) => next.steps[s.id]?.passed === true).length;
    const { at: _at, ...shown } = result;
    return ok({ step: step.id, ...shown, progress: `${passed}/${plan.value.steps.length} steps passed` });
  }
}

export interface PlanProgressView {
  readonly done: boolean;
  readonly passed: number;
  readonly total: number;
  readonly steps: readonly { readonly id: string; readonly status: "passed" | "failed" | "pending" }[];
}

/** `plan progress <plan.json>`: every step's checkpoint; the build stage's gate asks for all passed. */
export class PlanProgress {
  constructor(private readonly fs: FileSystem) {}

  async execute(input: { readonly file: string }): Promise<Result<PlanProgressView, MetatorError>> {
    const plan = await readPlan(this.fs, input.file);
    if (plan.isErr()) return err(plan.error);
    const progress = await readProgress(this.fs, input.file);
    if (progress.isErr()) return err(progress.error);
    const steps = plan.value.steps.map((s) => {
      const r = progress.value.steps[s.id];
      return { id: s.id, status: r === undefined ? "pending" : r.passed ? "passed" : "failed" } as const;
    });
    const passed = steps.filter((s) => s.status === "passed").length;
    return ok({ done: passed === steps.length, passed, total: steps.length, steps });
  }
}
