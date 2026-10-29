import type { MetatorStep } from "../domain/config.ts";
import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { ApiSnapshots } from "./api.ts";
import type { CheckArchitecture } from "./architecture.ts";
import type { DiffContracts } from "./contract-diff.ts";
import type { DiffCoverage } from "./coverage.ts";
import type { DiffImportGraph } from "./graph-diff.ts";
import type { CheckRules } from "./rules.ts";
import type { RunAffectedTests } from "./test-affected.ts";

export interface GateCheckResult {
  readonly passed: boolean;
  readonly detail?: string;
}

const lines = (items: readonly string[], max = 20) => items.slice(0, max).join("\n");

/**
 * MetatorAI checks a gate runs in process (ADR-0041): each maps its report to pass or fail with
 * the lines a person needs. The gate's files or base scope the checks that can be scoped.
 */
export class GateChecks {
  constructor(
    private readonly rules: Pick<CheckRules, "execute">,
    private readonly tests: Pick<RunAffectedTests, "execute">,
    private readonly graph: Pick<DiffImportGraph, "execute">,
    private readonly api: Pick<ApiSnapshots, "diff">,
    private readonly coverage: Pick<DiffCoverage, "execute">,
    private readonly arch: Pick<CheckArchitecture, "execute">,
    private readonly contracts?: Pick<DiffContracts, "execute">,
  ) {}

  async run(
    step: MetatorStep,
    scope: { readonly files?: readonly string[]; readonly base?: string },
  ): Promise<Result<GateCheckResult, MetatorError>> {
    const base = scope.base ?? "HEAD";
    switch (step.command) {
      case "rules check": {
        const r = await this.rules.execute(scope.files ? { files: scope.files } : {});
        if (r.isErr()) return err(r.error);
        const errors = r.value.violations.filter((v) => v.severity === "error");
        return ok(
          errors.length === 0
            ? { passed: true }
            : {
                passed: false,
                detail: lines(
                  errors.map(
                    (v) =>
                      `${v.file}:${v.line ?? 1} ${v.canonRuleId ?? v.toolRuleId ?? v.engine}: ${v.message}`,
                  ),
                ),
              },
        );
      }
      case "test affected": {
        const r = await this.tests.execute({
          ...(scope.files ? { changed: scope.files } : { base }),
          script: "test",
        });
        if (r.isErr()) return err(r.error);
        return ok(
          r.value.passed
            ? { passed: true, detail: `${r.value.tests.length} affected test file(s)` }
            : { passed: false, detail: r.value.output ?? "" },
        );
      }
      case "graph diff": {
        const r = await this.graph.execute({ base });
        if (r.isErr()) return err(r.error);
        const coupling = r.value.newPackageDependencies.map(
          (d) => `new package dependency ${d.from} → ${d.to} (${d.via})`,
        );
        if (r.value.newCycles.length > 0)
          return ok({
            passed: false,
            detail: lines([...r.value.newCycles.map((c) => `new cycle: ${c.join(" → ")}`), ...coupling]),
          });
        return ok({ passed: true, ...(coupling.length > 0 ? { detail: lines(coupling) } : {}) });
      }
      case "arch check": {
        const r = await this.arch.execute({ base });
        if (r.isErr()) return err(r.error);
        const added = r.value.failing.map((v) => `${v.id}: ${v.message}`);
        return ok(
          added.length > 0
            ? { passed: false, detail: lines(added) }
            : { passed: true, detail: `score ${r.value.summary.score}, no new architecture violation` },
        );
      }
      case "contract diff": {
        if (!this.contracts) return ok({ passed: false, detail: "contract diff is not available here" });
        const r = await this.contracts.execute({ base });
        if (r.isErr()) return err(r.error);
        const failing = r.value.contracts.filter((c) => !c.allowed);
        const changed = r.value.contracts.filter((c) => c.status !== "unchanged").length;
        return ok(
          failing.length > 0
            ? { passed: false, detail: lines(failing.map((c) => `${c.id} (${c.status}): ${c.reason ?? ""}`)) }
            : {
                passed: true,
                detail: `${changed} of ${r.value.contracts.length} contract(s) changed, none breaking`,
              },
        );
      }
      case "api diff": {
        const r = await this.api.diff({ package: step.package });
        if (r.isErr()) return err(r.error);
        return ok(
          r.value.changed
            ? {
                passed: false,
                detail: lines(
                  r.value.files.flatMap((f) => [
                    ...f.removed.map((l) => `${f.path}: - ${l}`),
                    ...f.added.map((l) => `${f.path}: + ${l}`),
                  ]),
                ),
              }
            : { passed: true },
        );
      }
      case "coverage diff": {
        const r = await this.coverage.execute({ base, ...(step.lcov ? { lcov: step.lcov } : {}) });
        if (r.isErr()) return err(r.error);
        const summary = `${r.value.percent}% of ${r.value.instrumented} added line(s) covered`;
        if (step.min !== undefined && r.value.percent < step.min)
          return ok({
            passed: false,
            detail: lines([
              summary,
              ...r.value.files
                .filter((f) => f.uncovered.length > 0)
                .map((f) => `${f.file}: uncovered ${f.uncovered.join(", ")}`),
            ]),
          });
        return ok({ passed: true, detail: summary });
      }
    }
  }
}
