import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * Review findings (Find → Verify → Judge, ADR-0031). A finding must prove itself: the quote must
 * exist in the file, and a blocking finding names the trigger, the path from a real caller
 * (reachability) and its evidence.
 */
export const LENSES = ["logic", "contracts", "conventions", "tests", "security", "equivalence"] as const;
export const SEVERITIES = ["blocking", "major", "minor", "nit"] as const;
export type FindingSeverity = (typeof SEVERITIES)[number];

export const FindingSchema = z.strictObject({
  id: z.string().regex(/^[A-Z]+-\d{3}$/, "expected an id like LOGIC-007"),
  lens: z.enum(LENSES),
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1),
  ruleId: z.string().optional(),
  location: z.strictObject({
    file: z.string().min(1),
    line: z.number().int().positive(),
    symbol: z.string().optional(),
  }),
  /** Exact code at the location; checked against the file. */
  quote: z.string().min(1),
  claim: z.string().min(10),
  /** The concrete input or state that triggers the problem. */
  trigger: z.string().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  /** The path from a real caller to the location. */
  reachability: z.string().optional(),
  evidence: z
    .strictObject({ type: z.enum(["test", "trace", "rule", "doc"]), ref: z.string().min(1) })
    .optional(),
  fixHint: z.string().optional(),
  /** Added by the verifier: an attempt to refute the finding. */
  verification: z
    .strictObject({
      status: z.enum(["confirmed", "refuted", "unproven"]),
      by: z.string().min(1),
      evidence: z.string().min(1),
    })
    .optional(),
  /** Lenses that reported the same root cause (after merge). */
  alsoFrom: z.array(z.enum(LENSES)).optional(),
});
export type Finding = z.output<typeof FindingSchema>;

export const FindingSetSchema = z.strictObject({
  lens: z.union([z.enum(LENSES), z.literal("merged")]),
  shard: z.string().optional(),
  findings: z.array(FindingSchema),
});
export type FindingSet = z.output<typeof FindingSetSchema>;

export const FindingSetDocument = defineDocument("FindingSet", {
  latest: FindingSetSchema,
  hint: "Fix the findings file; `metator findings schema` prints the JSON Schema.",
});

/** Policy beyond the schema: what a blocking finding must carry, what verification allows. */
export function policyProblems(f: Finding): string[] {
  const problems: string[] = [];
  if (f.severity === "blocking") {
    for (const field of ["trigger", "reachability", "evidence"] as const) {
      if (!f[field]) problems.push(`blocking needs ${field}`);
    }
  }
  if (f.verification?.status === "refuted" && f.severity === "blocking")
    problems.push("a refuted finding cannot block");
  // Without executable evidence a verified finding is at most major (research §8.3).
  if (f.verification?.status === "confirmed" && f.severity === "blocking" && f.evidence?.type === "doc") {
    problems.push("blocking needs executable evidence (test, trace or rule), not doc");
  }
  return problems;
}

const RANK: Readonly<Record<FindingSeverity, number>> = { blocking: 3, major: 2, minor: 1, nit: 0 };

const words = (claim: string) => new Set(claim.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

/** Same root cause: same place (file and symbol, or line) and the same rule or a similar claim. */
export function sameRootCause(a: Finding, b: Finding): boolean {
  if (a.location.file !== b.location.file) return false;
  if ((a.location.symbol ?? a.location.line) !== (b.location.symbol ?? b.location.line)) return false;
  if (a.ruleId && b.ruleId) return a.ruleId === b.ruleId;
  const wa = words(a.claim);
  const wb = words(b.claim);
  const common = [...wa].filter((w) => wb.has(w)).length;
  return common / (wa.size + wb.size - common || 1) >= 0.5;
}

/** Merges duplicates across lenses: highest severity and confidence win, lenses are kept. */
export function mergeFindings(findings: readonly Finding[]): { merged: Finding[]; duplicates: number } {
  const groups: Finding[][] = [];
  for (const f of findings) {
    const group = groups.find((g) => g.some((other) => sameRootCause(f, other)));
    if (group) group.push(f);
    else groups.push([f]);
  }
  const merged: Finding[] = [];
  for (const group of groups) {
    const [best] = [...group].sort(
      (a, b) => RANK[b.severity] - RANK[a.severity] || b.confidence - a.confidence,
    );
    const others = [...new Set(group.map((f) => f.lens).filter((l) => l !== best?.lens))].sort();
    merged.push({ ...(best as Finding), ...(others.length > 0 ? { alsoFrom: others } : {}) });
  }
  merged.sort(
    (a, b) =>
      RANK[b.severity] - RANK[a.severity] ||
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line,
  );
  return { merged, duplicates: findings.length - merged.length };
}
