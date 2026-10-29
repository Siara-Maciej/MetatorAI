import { z } from "zod";
import { matchesAny } from "./glob.ts";
import { defineDocument } from "./versioned.ts";

/**
 * How the packages of a repository may depend on each other (H2, design/11): layers, tags and
 * tag rules (the shape of Nx `depConstraints` and Turborepo `boundaries`), test globs, metric
 * thresholds and exceptions that expire. `metator/architecture.yml`; written by people
 * (`arch init` proposes one) and reviewed like code.
 */
export const VIOLATION_KINDS = [
  "cycle",
  "layer",
  "tag",
  "app-import",
  "undeclared",
  "root-only",
  "dev-in-prod",
  "relative-import",
  "unused-dependency",
  "version-drift",
  "unlayered",
  "threshold",
  "expired-exception",
  "unused-exception",
] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];

export type ArchSeverity = "error" | "warning";

/** What each kind weighs unless the policy says otherwise. */
export const DEFAULT_SEVERITY: Readonly<Record<ViolationKind, ArchSeverity>> = {
  cycle: "error",
  layer: "error",
  tag: "error",
  "app-import": "error",
  undeclared: "error",
  "root-only": "warning",
  "dev-in-prod": "error",
  "relative-import": "error",
  "unused-dependency": "warning",
  "version-drift": "warning",
  unlayered: "warning",
  threshold: "warning",
  "expired-exception": "error",
  "unused-exception": "warning",
};

export const ARCH_TEST_GLOBS: readonly string[] = [
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/e2e/**",
  "**/fixtures/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.stories.*",
];

/** A package name (`@shop/ui-*`) or directory (`apps/*`) glob. */
const PackagePattern = z.string().min(1);
const Tag = z.string().regex(/^[^\s,]+$/, "a tag without spaces or commas");

const PackageRuleSchema = z.strictObject({
  /** Packages the rule applies to, by name or directory glob. */
  packages: z.array(PackagePattern).min(1),
  kind: z.enum(["app", "lib"]).optional(),
  tags: z.array(Tag).optional(),
  layer: z.string().min(1).optional(),
});

const LayerSchema = z
  .strictObject({
    name: z.string().min(1),
    packages: z.array(PackagePattern).optional(),
    tags: z.array(Tag).optional(),
  })
  .refine((l) => (l.packages?.length ?? 0) + (l.tags?.length ?? 0) > 0, "a layer lists packages or tags");

const TagRuleSchema = z
  .strictObject({
    /** Packages with this tag (`*` for every package) may depend only on `allow` and never on `deny`... */
    from: Tag.optional(),
    /** ...or: packages with this tag may be depended on only by `allow` and never by `deny`. */
    to: Tag.optional(),
    /** Tags the other side must have one of (`*` for any). */
    allow: z.array(Tag).optional(),
    /** Tags the other side must not have. */
    deny: z.array(Tag).optional(),
  })
  .refine((r) => (r.from === undefined) !== (r.to === undefined), "a rule names either from or to")
  .refine((r) => r.allow !== undefined || r.deny !== undefined, "a rule allows or denies tags");

const ExceptionSchema = z.strictObject({
  /** A violation id (`layer:@shop/db→@shop/web`) or a glob over ids (`cycle:*`). */
  violation: z.string().min(1),
  reason: z.string().min(1),
  owner: z.string().min(1),
  /** `YYYY-MM-DD`; afterwards the violation counts again and the exception is an error. */
  expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date YYYY-MM-DD"),
});

const ThresholdsSchema = z.strictObject({
  /** Distance from the main sequence |A + I − 1| above which a package is reported. */
  distance: z.number().min(0).max(1).optional(),
  /** Workspace packages a package may depend on. */
  fanOut: z.number().int().positive().optional(),
  /** Workspace packages that may depend on one package. */
  fanIn: z.number().int().positive().optional(),
  /** Source files in one package. */
  files: z.number().int().positive().optional(),
  /** Length of the longest dependency chain below a package. */
  depth: z.number().int().positive().optional(),
});

export const ArchitecturePolicySchema = z.strictObject({
  packages: z.array(PackageRuleSchema).default([]),
  /** Ordered top to bottom: a package may depend on its own layer and the layers below it. */
  layers: z.array(LayerSchema).default([]),
  rules: z.array(TagRuleSchema).default([]),
  /** Test files (they may use devDependencies and do not make cycles); default ARCH_TEST_GLOBS. */
  tests: z.array(z.string().min(1)).optional(),
  /** Files left out of the analysis (generated code, vendored copies). */
  ignore: z.array(z.string().min(1)).default([]),
  thresholds: ThresholdsSchema.default({}),
  severity: z.partialRecord(z.enum(VIOLATION_KINDS), z.enum(["error", "warning", "off"])).default({}),
  exceptions: z.array(ExceptionSchema).default([]),
});
export type ArchitecturePolicy = z.output<typeof ArchitecturePolicySchema>;
export type ArchitectureException = ArchitecturePolicy["exceptions"][number];

export const ArchitecturePolicyDocument = defineDocument("ArchitecturePolicy", {
  latest: ArchitecturePolicySchema,
  errorCode: "INVALID_CONFIG",
  hint: "`metator arch init` proposes a policy from the packages it finds.",
});

/** A repository without `metator/architecture.yml`: no layers or rules, default tests and severities. */
export const EMPTY_POLICY: ArchitecturePolicy = ArchitecturePolicySchema.parse({});

/** True when a package pattern names the package or its directory. */
export function matchesPackage(
  pattern: string,
  pkg: { readonly name: string; readonly dir: string },
): boolean {
  return (
    pattern === pkg.name ||
    pattern === pkg.dir ||
    matchesAny(pkg.name, [pattern]) ||
    matchesAny(pkg.dir, [pattern])
  );
}

/** Tags of a package: its own (Nx `project.json`, Turborepo `turbo.json`) plus the policy's. */
export function tagsOf(
  policy: ArchitecturePolicy,
  pkg: { readonly name: string; readonly dir: string; readonly tags: readonly string[] },
): string[] {
  const tags = new Set(pkg.tags);
  for (const rule of policy.packages)
    if (rule.packages.some((p) => matchesPackage(p, pkg))) for (const t of rule.tags ?? []) tags.add(t);
  return [...tags].sort();
}

/** The layer index of a package (0 is the top), or undefined when no layer claims it. */
export function layerOf(
  policy: ArchitecturePolicy,
  pkg: { readonly name: string; readonly dir: string },
  tags: readonly string[],
): number | undefined {
  for (const rule of policy.packages) {
    if (rule.layer === undefined || !rule.packages.some((p) => matchesPackage(p, pkg))) continue;
    const index = policy.layers.findIndex((l) => l.name === rule.layer);
    if (index >= 0) return index;
  }
  const index = policy.layers.findIndex(
    (l) =>
      (l.packages ?? []).some((p) => matchesPackage(p, pkg)) || (l.tags ?? []).some((t) => tags.includes(t)),
  );
  return index >= 0 ? index : undefined;
}

/** The tag rules a dependency `from → to` breaks, as messages. */
export function brokenTagRules(
  policy: ArchitecturePolicy,
  fromTags: readonly string[],
  toTags: readonly string[],
): string[] {
  const broken: string[] = [];
  const has = (tags: readonly string[], tag: string) => tag === "*" || tags.includes(tag);
  for (const rule of policy.rules) {
    // A `from` rule judges the dependency's tags; a `to` rule judges the dependent's.
    const subject = rule.from ?? (rule.to as string);
    if (!has(rule.from === undefined ? toTags : fromTags, subject)) continue;
    const other = rule.from === undefined ? fromTags : toTags;
    const allowed = rule.allow;
    if (allowed && !allowed.includes("*") && !allowed.some((t) => other.includes(t)))
      broken.push(
        rule.from === undefined
          ? `only ${allowed.join(", ")} may depend on ${subject}`
          : `${subject} may depend only on ${allowed.join(", ")}`,
      );
    const denied = (rule.deny ?? []).filter((t) => other.includes(t));
    if (denied.length > 0)
      broken.push(
        rule.from === undefined
          ? `${denied.join(", ")} must not depend on ${subject}`
          : `${subject} must not depend on ${denied.join(", ")}`,
      );
  }
  return broken;
}

/** Problems in the policy itself that its schema cannot see. */
export function lintPolicy(policy: ArchitecturePolicy): string[] {
  const problems: string[] = [];
  const names = policy.layers.map((l) => l.name);
  for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i)))
    problems.push(`two layers are named ${name}`);
  for (const rule of policy.packages)
    if (rule.layer !== undefined && !names.includes(rule.layer))
      problems.push(
        `packages ${rule.packages.join(", ")} name the layer ${rule.layer}, which is not in layers`,
      );
  return problems;
}
