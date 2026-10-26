import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * Pattern catalog (ADR-0023): one versioned `Pattern` YAML document per pattern under
 * `docs/metator/patterns/`. A tool rule detects occurrences (`detection`, e.g. an ast-grep rule
 * with `severity: hint`), one occurrence is the exemplar to copy, legacy files are never shown.
 */
export const PatternSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "expected a kebab-case id, e.g. use-case"),
  title: z.string().min(3),
  /** What the pattern is for, in one sentence. */
  intent: z.string().min(10),
  when: z.string().min(3),
  whenNot: z.string().optional(),
  /** `<engine>:<rule id>` of the rule that finds occurrences. */
  detection: z.string().regex(/^[a-z][a-z0-9-]*:\S+$/, "expected <engine>:<rule id>"),
  /** The occurrence to copy: a repo-relative file the detection finds. */
  exemplar: z.string().min(1),
  /** Canon rules the pattern implements. */
  rules: z.array(z.string()).default([]),
  /** Files that match the detection but must not be copied, with the reason. */
  legacy: z.array(z.strictObject({ path: z.string().min(1), reason: z.string().min(3) })).default([]),
  minOccurrences: z.number().int().min(1).default(2),
});
export type Pattern = z.output<typeof PatternSchema>;

export const PatternDocument = defineDocument("Pattern", {
  latest: PatternSchema,
  errorCode: "INVALID_CONFIG",
  hint: "Fix the listed issues; `metator patterns schema` prints the JSON Schema.",
});

const Occurrence = z.strictObject({ file: z.string(), line: z.number().int() });

/** Derived index of pattern occurrences (`.metator/index/patterns.json`). */
export const PatternIndexDocument = defineDocument("PatternIndex", {
  latest: z.strictObject({
    patterns: z.array(
      z.strictObject({
        id: z.string(),
        occurrences: z.array(Occurrence),
        byPackage: z.record(z.string(), z.number().int()),
      }),
    ),
  }),
});

/** Path similarity used by `similar`: shared directories, file suffix and package. */
export function pathAffinity(candidate: string, target: string): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const a = candidate.split("/");
  const b = target.split("/");
  let shared = 0;
  while (shared < Math.min(a.length, b.length) - 1 && a[shared] === b[shared]) shared++;
  if (shared > 0) {
    score += shared;
    reasons.push(`same directory prefix ${a.slice(0, shared).join("/")}/`);
  }
  const suffix = (p: string) => /(\.[a-z0-9-]+)?\.[a-z0-9]+$/i.exec(p.split("/").pop() ?? "")?.[0] ?? "";
  const sa = suffix(candidate);
  if (sa.split(".").length > 2 && sa === suffix(target)) {
    score += 3;
    reasons.push(`same file kind *${sa}`);
  }
  return { score, reasons };
}
