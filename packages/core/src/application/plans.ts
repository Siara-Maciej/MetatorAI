import type { MetatorError } from "../domain/errors.ts";
import {
  lintPlan,
  type Plan,
  PlanDocument,
  type PlanLint,
  type PlanScope,
  PlanScopeDocument,
  planScope,
} from "../domain/plan.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { FileSystem } from "../ports/index.ts";
import type { BuildImportGraph } from "./import-graph.ts";
import type { ScanPatterns } from "./patterns.ts";
import type { RuleCatalog } from "./rules.ts";

type ImportEdges = readonly { readonly from: string; readonly to: string }[];

async function readPlan(fs: FileSystem, file: string): Promise<Result<Plan, MetatorError>> {
  const text = await fs.read(file);
  if (text.isErr()) return err(text.error);
  return parseJsonDocument(text.value, file).andThen((raw) => PlanDocument.parse(raw, file));
}

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
    const scan = await this.patterns.execute();
    if (scan.isErr()) return err(scan.error);
    const imports = await internalImports(this.graph);
    if (imports.isErr()) return err(imports.error);

    const files = new Set<string>();
    const named = plan.value.steps.flatMap((s) => [
      s.path,
      ...(s.patternSource ? [s.patternSource.exemplar.replace(/:\d+$/, "")] : []),
    ]);
    for (const path of new Set(named)) if (await this.fs.exists(path)) files.add(path);
    return ok(
      lintPlan(plan.value, {
        files,
        patterns: new Map(scan.value.patterns.map((p) => [p.id, new Set(p.occurrences.map((o) => o.file))])),
        rules: new Set((await this.rules.scan()).rules.map((r) => r.rule.id)),
        imports: imports.value,
        testGlobs: this.testGlobs,
      }),
    );
  }
}

/** `plan scope <plan.json>`: writes the edit scope and independent shards next to the plan. */
export class ScopePlan {
  constructor(
    private readonly fs: FileSystem,
    private readonly graph: Pick<BuildImportGraph, "execute">,
  ) {}

  async execute(input: {
    readonly file: string;
    readonly out?: string;
  }): Promise<Result<PlanScope & { readonly output: string }, MetatorError>> {
    const plan = await readPlan(this.fs, input.file);
    if (plan.isErr()) return err(plan.error);
    const imports = await internalImports(this.graph);
    if (imports.isErr()) return err(imports.error);
    const scope = planScope(plan.value, input.file, imports.value);
    const dir = input.file.includes("/") ? input.file.slice(0, input.file.lastIndexOf("/")) : ".";
    const output = input.out ?? `${dir}/plan-scope.json`;
    const saved = await this.fs.write(output, serializeJsonDocument(PlanScopeDocument.stamp(scope)));
    if (saved.isErr()) return err(saved.error);
    return ok({ ...scope, output });
  }
}
