import { z } from "zod";
import type { ArchitectureReport, Violation } from "./architecture.ts";
import { type ArchitecturePolicy, VIOLATION_KINDS } from "./architecture-policy.ts";
import { defineDocument } from "./versioned.ts";

/**
 * The architecture in CI (H2, ADR-0062): violations accepted for now (a baseline) and the
 * ratchet that fails a change only for what it adds, SARIF for code scanning, and a first
 * policy proposed from what the repository already is and the boundaries Nx or Turborepo know.
 */
export const ArchitectureBaselineSchema = z.strictObject({
  violations: z.array(z.strictObject({ id: z.string().min(1), kind: z.enum(VIOLATION_KINDS) })),
});
export type ArchitectureBaseline = z.output<typeof ArchitectureBaselineSchema>;

export const ArchitectureBaselineDocument = defineDocument("ArchitectureBaseline", {
  latest: ArchitectureBaselineSchema,
  errorCode: "INVALID_CONFIG",
  hint: "`metator arch baseline` writes it from the current report.",
});

/** Violations that count: not covered by an exception. */
export const activeViolations = (report: ArchitectureReport): Violation[] =>
  report.violations.filter((v) => !v.exception);

/** The baseline of a report: every violation that counts, by id. */
export function baselineOf(report: ArchitectureReport): ArchitectureBaseline {
  const seen = new Map(activeViolations(report).map((v) => [v.id, v.kind]));
  return {
    violations: [...seen.entries()]
      .map(([id, kind]) => ({ id, kind }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** A tightened baseline keeps what still exists and never accepts anything new. */
export function tightenBaseline(
  baseline: ArchitectureBaseline,
  report: ArchitectureReport,
): ArchitectureBaseline {
  const now = new Set(activeViolations(report).map((v) => v.id));
  return { violations: baseline.violations.filter((v) => now.has(v.id)) };
}

export interface ArchitectureComparison {
  /** Violations neither the base nor the baseline has. */
  readonly added: readonly Violation[];
  /** Of them, the ones that fail the check (errors; warnings too when strict). */
  readonly failing: readonly Violation[];
  /** Baseline entries that no longer occur: `arch baseline --tighten` drops them. */
  readonly fixed: readonly string[];
}

export function compareArchitecture(input: {
  readonly current: ArchitectureReport;
  readonly base?: ArchitectureReport;
  readonly baseline?: ArchitectureBaseline;
  readonly strict?: boolean;
}): ArchitectureComparison {
  const known = new Set([
    ...(input.base ? activeViolations(input.base).map((v) => v.id) : []),
    ...(input.baseline?.violations.map((v) => v.id) ?? []),
  ]);
  const active = activeViolations(input.current);
  const added = active.filter((v) => !known.has(v.id));
  const now = new Set(active.map((v) => v.id));
  return {
    added,
    failing: added.filter((v) => input.strict || v.severity === "error"),
    fixed: (input.baseline?.violations ?? []).map((v) => v.id).filter((id) => !now.has(id)),
  };
}

// ---------------------------------------------------------------------------------------------
// SARIF 2.1.0

const RULE_HELP: Readonly<Record<string, string>> = {
  cycle: "Packages depend on each other; cut the cheapest edge or extract what both need.",
  layer: "A package depends on a layer above its own.",
  tag: "A dependency breaks a tag rule of metator/architecture.yml.",
  "app-import": "Nothing may depend on an application.",
  undeclared: "Declare the dependency in the importing package's package.json.",
  "root-only": "Only the repository root declares this dependency; declare it in the package.",
  "dev-in-prod": "Code outside tests imports a devDependency; move it to dependencies.",
  "relative-import": "Import the other package by its name, not by a relative path.",
  "unused-dependency": "No file imports this dependency; remove it if nothing else needs it.",
  "version-drift": "Align the version ranges of this dependency across packages.",
  unlayered: "Give the package a layer in metator/architecture.yml.",
  threshold: "A metric is over the policy's threshold.",
  "expired-exception": "Fix the violation or renew the exception with a reason.",
  "unused-exception": "The exception matches nothing; remove it.",
};

/** A SARIF log of violations, one result per violation located at its first evidence file. */
export function architectureSarif(
  violations: readonly Violation[],
  policyFile: string | null,
): Record<string, unknown> {
  const kinds = [...new Set(violations.map((v) => v.kind))].sort();
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "metator-arch",
            informationUri: "https://github.com/Siara-Maciej/MetatorAI",
            rules: kinds.map((k) => ({
              id: `arch/${k}`,
              shortDescription: { text: RULE_HELP[k] ?? k },
            })),
          },
        },
        results: violations.map((v) => ({
          ruleId: `arch/${v.kind}`,
          level: v.severity,
          message: { text: v.message },
          partialFingerprints: { metatorArchId: v.id },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: v.evidence[0]?.file ?? policyFile ?? "package.json" },
                region: { startLine: 1 },
              },
            },
          ],
        })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// A first policy

export type TagRule = ArchitecturePolicy["rules"][number];

export interface ToolBoundaries {
  /** The file the rules came from (`turbo.json`, `.eslintrc.json`). */
  readonly source: string;
  readonly rules: readonly TagRule[];
}

const tags = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((t): t is string => typeof t === "string" && /^[^\s,]+$/.test(t));
  return list.length > 0 ? list : undefined;
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Turborepo `boundaries.tags`: `dependencies` become `from` rules, `dependents` become `to` rules. */
export function rulesFromTurbo(turbo: unknown): TagRule[] {
  const byTag = object(object(object(turbo)?.boundaries)?.tags) ?? {};
  const rules: TagRule[] = [];
  for (const [tag, spec] of Object.entries(byTag).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [side, key] of [
      ["from", "dependencies"],
      ["to", "dependents"],
    ] as const) {
      const s = object(object(spec)?.[key]);
      const allow = tags(s?.allow);
      const deny = tags(s?.deny);
      if (allow || deny) rules.push({ [side]: tag, ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) });
    }
  }
  return rules;
}

const NX_RULES = ["@nx/enforce-module-boundaries", "@nrwl/nx/enforce-module-boundaries"];

/** Nx `depConstraints` from an ESLint JSON config, in its rules or its overrides. */
export function rulesFromNxEslint(eslint: unknown): TagRule[] {
  const config = object(eslint);
  const blocks = [config, ...(Array.isArray(config?.overrides) ? config.overrides : [])];
  const rules: TagRule[] = [];
  for (const block of blocks) {
    for (const name of NX_RULES) {
      const entry = object(object(block)?.rules)?.[name];
      const options = Array.isArray(entry) ? object(entry[1]) : undefined;
      for (const c of Array.isArray(options?.depConstraints) ? options.depConstraints : []) {
        const constraint = object(c);
        const source = typeof constraint?.sourceTag === "string" ? constraint.sourceTag : undefined;
        const allow = tags(constraint?.onlyDependOnLibsWithTags);
        const deny = tags(constraint?.notDependOnLibsWithTags);
        if (source && (allow || deny))
          rules.push({ from: source, ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) });
      }
    }
  }
  return rules;
}

export interface PolicyProposal {
  readonly body: Record<string, unknown>;
  /** What the proposal is based on, for the comment at the top of the file. */
  readonly notes: readonly string[];
}

/**
 * What `arch init` writes: applications on top of everything else (a library never depends on an
 * application), the tags the packages already carry, and the rules Nx or Turborepo enforce. It
 * describes the repository as it is, so violations it would add are the ones to fix first.
 */
export function proposePolicy(report: ArchitectureReport, tools: readonly ToolBoundaries[]): PolicyProposal {
  const apps = report.packages.filter((p) => p.kind === "app").map((p) => p.name);
  const libs = report.packages.filter((p) => p.kind === "lib").map((p) => p.name);
  const layers: Record<string, unknown>[] = [];
  if (apps.length > 0) layers.push({ name: "apps", packages: apps });
  if (libs.length > 0) layers.push({ name: "libs", packages: libs });
  const rules = tools.flatMap((t) => t.rules);
  const notes = [
    `${apps.length} application(s), ${libs.length} librar${libs.length === 1 ? "y" : "ies"}, ${report.cycles.length} cycle(s) found.`,
    ...tools.map((t) => `${t.rules.length} rule(s) imported from ${t.source}.`),
    "Split libs into the layers you intend (e.g. features, domain, shared); `metator arch analyze` shows what breaks.",
  ];
  return {
    body: {
      ...(layers.length > 0 ? { layers } : {}),
      ...(rules.length > 0 ? { rules } : {}),
    },
    notes,
  };
}
