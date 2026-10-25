import { z } from "zod";
import { matchesAny } from "./glob.ts";
import { defineDocument } from "./versioned.ts";

/**
 * Rule canon (ADR-0020): one versioned `RuleSet` YAML document per area under
 * `docs/metator/rules/`. Rule IDs are `<PREFIX>-<AREA>-NNN`, immutable and never reused.
 *
 * Enforcement levels:
 * - E1: a tool decides (ast-grep, Biome, tsc); the rule names the implementation and its test.
 * - E2: checkable by a reviewer against the diff with the rule pack (concrete do/don't).
 * - E3: guidance that needs judgment.
 */
export const RULE_ID = /^[A-Z][A-Z0-9]*-([A-Z][A-Z0-9]*)-\d{3}$/;

export const EnforcementLevelSchema = z.enum(["E1", "E2", "E3"]);
export type EnforcementLevel = z.output<typeof EnforcementLevelSchema>;

const Implementation = z
  .string()
  .regex(/^[a-z][a-z0-9-]*:\S+$/, "expected <engine>:<tool rule id>, e.g. ast-grep:no-deep-import");

export const RuleSchema = z
  .strictObject({
    id: z.string().regex(RULE_ID, "expected <PREFIX>-<AREA>-NNN, e.g. MT-ARCH-003"),
    title: z.string().min(5),
    status: z.enum(["active", "draft", "deprecated"]).default("active"),
    applyTo: z.array(z.string().min(1)).min(1),
    enforcement: EnforcementLevelSchema,
    /** Required for E1: where the tool rule lives, as `<engine>:<rule id>`. */
    implementation: Implementation.optional(),
    /** One sentence an agent can act on; the rule pack shows this. */
    summary: z.string().min(10),
    /** Why the rule exists: an ADR or document path (optionally with #anchor). */
    rationale: z.string().min(1),
    source: z.strictObject({
      ref: z.string().min(1),
      verified: z.iso.date(),
    }),
    do: z.array(z.string()).default([]),
    dont: z.array(z.string()).default([]),
    conflictsWith: z.array(z.string()).default([]),
    supersededBy: z.string().optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.enforcement === "E1" && !rule.implementation) {
      ctx.addIssue({
        code: "custom",
        path: ["implementation"],
        message: "E1 rules must name their implementation",
      });
    }
    if (rule.enforcement !== "E1" && rule.implementation) {
      ctx.addIssue({
        code: "custom",
        path: ["enforcement"],
        message: "a rule with an implementation is E1 (a tool enforces it)",
      });
    }
    if (rule.supersededBy && rule.status !== "deprecated") {
      ctx.addIssue({
        code: "custom",
        path: ["supersededBy"],
        message: "only deprecated rules are superseded",
      });
    }
  });

export type Rule = z.output<typeof RuleSchema>;

export const RuleSetSchema = z.strictObject({
  area: z.string().regex(/^[A-Z][A-Z0-9]*$/, "expected an upper-case area, e.g. ARCH"),
  description: z.string().optional(),
  rules: z.array(RuleSchema).min(1),
});

export type RuleSet = z.output<typeof RuleSetSchema>;

export const RuleSetDocument = defineDocument("RuleSet", {
  latest: RuleSetSchema,
  errorCode: "INVALID_CONFIG",
  hint: "Fix the listed issues; `metator rules schema` prints the JSON Schema.",
});

export function areaOf(id: string): string | undefined {
  return RULE_ID.exec(id)?.[1];
}

export function prefixOf(id: string): string {
  return id.split("-")[0] as string;
}

/** `ast-grep:mt-arch-domain-pure` → { engine: "ast-grep", ruleId: "mt-arch-domain-pure" }. */
export function parseImplementation(implementation: string): { engine: string; ruleId: string } {
  const at = implementation.indexOf(":");
  return { engine: implementation.slice(0, at), ruleId: implementation.slice(at + 1) };
}

/** Active rules that apply to at least one of the paths. */
export function rulesFor(rules: readonly Rule[], paths: readonly string[]): Rule[] {
  return rules.filter((r) => r.status === "active" && paths.some((p) => matchesAny(p, r.applyTo)));
}

/** Rough token estimate used for context budgets (≈ 4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Generated host instruction file (front matter keeps the host's `applyTo`). */
export const InstructionsAdapterDocument = defineDocument("InstructionsAdapter", {
  latest: z.object({
    applyTo: z.string(),
    description: z.string(),
    generatedFrom: z.string(),
  }),
});
