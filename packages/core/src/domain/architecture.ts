import { appsOf, boundariesOf, couplingOf, teamsOf } from "./architecture-boundaries.ts";
import { type ArchitectureInput, archContext } from "./architecture-context.ts";
import {
  type ArchitecturePolicy,
  type ArchSeverity,
  DEFAULT_SEVERITY,
  type ViolationKind,
} from "./architecture-policy.ts";
import type {
  ArchCycle,
  ArchEdge,
  ArchitectureReport,
  ArchPackage,
  Violation,
} from "./architecture-report.ts";
import { ARCH_RULES } from "./architecture-rules.ts";

/**
 * The architecture of a repository's packages (H1–H4, design/11): the package graph aggregated
 * from the file-level import graph, its cycles, declared against used dependencies, the policy's
 * layers and tag rules, metrics and boundaries. Everything here is computed, never judged: a
 * refactor plan proposes moves, and the same analysis on the moved graph proves them.
 */

/** The package graph and everything wrong with it, for one state of the repository. */
export function analyzeArchitecture(input: ArchitectureInput): ArchitectureReport {
  const ctx = archContext(input);
  const { packages, edges, cycles } = ctx;
  const violations = applyPolicy(
    ARCH_RULES.flatMap((rule) => rule(ctx)),
    ctx.policy,
    input.today,
  );
  const withMetrics: ArchPackage[] = packages.map((p) => {
    const metrics = ctx.metrics.get(p.name);
    return metrics ? { ...p, metrics } : p;
  });
  const apps = appsOf(ctx);
  return {
    policy: input.policySource,
    summary: summarize(packages, edges, cycles, violations),
    packages: withMetrics,
    boundaries: boundariesOf(ctx, withMetrics),
    ...(input.history ? { coupling: couplingOf(ctx, input.history) } : {}),
    ...(input.owners && input.owners.size > 0 ? { teams: teamsOf(ctx, input.owners) } : {}),
    ...(apps ? { apps } : {}),
    edges: [...edges],
    cycles: [...cycles],
    violations,
    ...(ctx.inner ? { modules: ctx.inner } : {}),
    unresolved: {
      count: input.unresolved.length,
      sample: input.unresolved.slice(0, 50).map((u) => ({ ...u })),
    },
  };
}

/** An exception's `violation`: an id, or a pattern where `*` stands for any text. */
export function matchesId(pattern: string, id: string): boolean {
  if (!pattern.includes("*")) return pattern === id;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(id);
}

/** Severities from the policy, then exceptions: covered, expired (an error) or unused (a warning). */
export function applyPolicy(
  violations: readonly Violation[],
  policy: ArchitecturePolicy,
  today: string,
): Violation[] {
  const out: Violation[] = [];
  const usedExceptions = new Set<number>();
  for (const v of violations) {
    const severity = policy.severity[v.kind] ?? v.severity;
    if (severity === "off") continue;
    const index = policy.exceptions.findIndex((x) => matchesId(x.violation, v.id));
    const exception = policy.exceptions[index];
    if (exception) usedExceptions.add(index);
    out.push({
      ...v,
      severity: severity as ArchSeverity,
      ...(exception && exception.expires >= today
        ? { exception: { reason: exception.reason, owner: exception.owner, expires: exception.expires } }
        : {}),
    });
  }
  const extra: Violation[] = [];
  policy.exceptions.forEach((x, i) => {
    const raise = (kind: ViolationKind, message: string) => {
      const severity = policy.severity[kind] ?? DEFAULT_SEVERITY[kind];
      if (severity !== "off")
        extra.push({
          id: `${kind}:${x.violation}`,
          kind,
          severity: severity as ArchSeverity,
          message,
          packages: [],
          evidence: [],
        });
    };
    if (!usedExceptions.has(i))
      raise(
        "unused-exception",
        `the exception for ${x.violation} (${x.owner}) matches no violation; remove it`,
      );
    else if (x.expires < today)
      raise("expired-exception", `the exception for ${x.violation} (${x.owner}) expired on ${x.expires}`);
  });
  const rank = (v: Violation) => (v.severity === "error" ? 0 : 1);
  return [...out, ...extra].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

function summarize(
  packages: readonly ArchPackage[],
  edges: readonly ArchEdge[],
  cycles: readonly ArchCycle[],
  violations: readonly Violation[],
): ArchitectureReport["summary"] {
  const active = violations.filter((v) => !v.exception);
  const errors = active.filter((v) => v.severity === "error").length;
  const warnings = active.length - errors;
  return {
    packages: packages.filter((p) => p.kind !== "root").length,
    apps: packages.filter((p) => p.kind === "app").length,
    edges: edges.filter((e) => !e.testOnly).length,
    cycles: cycles.length,
    errors,
    warnings,
    excepted: violations.length - active.length,
    score: Math.max(0, 100 - 5 * errors - warnings),
  };
}
