import { z } from "zod";
import { type Finding, FindingSchema } from "./finding.ts";
import { defineDocument } from "./versioned.ts";

/**
 * The deterministic part of Judge (ADR-0032): only confirmed blocking findings change the
 * decision; an unverified blocker means "not decided yet"; unproven findings never block.
 */
export const DECISIONS = ["APPROVED", "CHANGES_REQUIRED", "NEEDS_VERIFICATION"] as const;

export const VerdictSchema = z.strictObject({
  decision: z.enum(DECISIONS),
  /** Confirmed blocking findings: why the change cannot merge. */
  blocking: z.array(FindingSchema),
  /** Blocking findings nobody verified yet: Verify must run before a decision. */
  unverified: z.array(FindingSchema),
  /** Everything else worth reading: major, minor, nit, unproven, refuted-but-informative excluded. */
  consider: z.array(FindingSchema),
  /** Areas the reviewers checked and found correct (filled by the judge agent). */
  verifiedCorrect: z.array(z.string()).default([]),
});
export type Verdict = z.output<typeof VerdictSchema>;

export const VerdictDocument = defineDocument("Verdict", { latest: VerdictSchema });

export function judge(findings: readonly Finding[], verifiedCorrect: readonly string[] = []): Verdict {
  const live = findings.filter((f) => f.verification?.status !== "refuted");
  const blocking = live.filter((f) => f.severity === "blocking" && f.verification?.status === "confirmed");
  const unverified = live.filter((f) => f.severity === "blocking" && !f.verification);
  const consider = live.filter((f) => !blocking.includes(f) && !unverified.includes(f));
  const decision =
    unverified.length > 0 ? "NEEDS_VERIFICATION" : blocking.length > 0 ? "CHANGES_REQUIRED" : "APPROVED";
  return { decision, blocking, unverified, consider, verifiedCorrect: [...verifiedCorrect] };
}

export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

/**
 * Review comments for a code host: inline only for confirmed blocking findings (the rest goes
 * to the summary, so the PR is not flooded). `labeled` starts each comment with severity and id,
 * `natural` reads like a person wrote it.
 */
export function toComments(
  verdict: Verdict,
  format: "natural" | "labeled",
): { comments: ReviewComment[]; summary: string } {
  const body = (f: Finding) => {
    const fix = f.fixHint ? `\n\nSuggested fix: ${f.fixHint}` : "";
    const rule = f.ruleId ? ` (${f.ruleId})` : "";
    const why = [
      f.trigger ? `Trigger: ${f.trigger}.` : "",
      f.reachability ? `Reached via ${f.reachability}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return format === "labeled"
      ? `**[${f.severity}] ${f.id}**${rule}: ${f.claim}${why ? `\n\n${why}` : ""}${fix}`
      : `${f.claim}${rule}.${why ? ` ${why}` : ""}${fix}`;
  };
  const comments = verdict.blocking.map((f) => ({
    path: f.location.file,
    line: f.location.line,
    body: body(f),
  }));
  const line = (f: Finding) =>
    `- ${format === "labeled" ? `[${f.severity}] ${f.id}: ` : ""}${f.location.file}:${f.location.line} ${f.claim}`;
  const summary = [
    `**${verdict.decision.replace("_", " ")}**`,
    verdict.blocking.length > 0 ? `\nBlocking (${verdict.blocking.length}), commented inline.` : "",
    verdict.consider.length > 0 ? `\nTo consider:\n${verdict.consider.map(line).join("\n")}` : "",
    verdict.verifiedCorrect.length > 0
      ? `\nVerified correct:\n${verdict.verifiedCorrect.map((v) => `- ${v}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { comments, summary };
}
