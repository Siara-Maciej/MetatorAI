import { z } from "zod";
import { digestOf } from "./ids.ts";
import type { Plan } from "./plan.ts";
import type { SystemMap } from "./system-map.ts";
import type { SystemPlan } from "./system-plan.ts";
import { defineDocument, type VersionedDocument } from "./versioned.ts";

/**
 * A person edits plans in the app (ADR-0087): the run's implementation plan, a system plan and
 * the system map. What every edit shares is here: the views the daemon answers with, the digest
 * a write must name (optimistic concurrency), a body checked against its document's schema with
 * the problems as lint, what changed between two versions, and the edit log.
 */

/** One problem of a plan as the app lists it: a schema issue names its `field`, a lint issue its step. */
export interface PlanLintProblem {
  readonly severity: "error" | "warning";
  readonly code?: string;
  readonly message: string;
  readonly step?: string;
  readonly field?: string;
}

export interface PlanLintView {
  readonly problems: readonly PlanLintProblem[];
}

/** `GET /runs/:run/plan`: the run's implementation plan, its lint, and whether a person may change it. */
export interface RunPlanView {
  readonly plan: Plan | null;
  /** What a write must name: the digest of the plan it was based on; null when there is no plan. */
  readonly digest: string | null;
  readonly lint: PlanLintView;
  readonly editable: boolean;
  readonly readOnlyBecause?: string;
  readonly stage: string;
  /** What the run's workflow says its stages write (`produces`), in stage order. */
  readonly artifactsOfWorkflow: readonly string[];
  /** The plan's file, relative to the repository. */
  readonly file: string;
  /** The stage whose approval freezes the plan (a `hitl` stage after the plan), when the workflow has one. */
  readonly approvalStage?: string;
  /** The open question of that stage, when one waits: its card is about this plan. */
  readonly question?: string;
  /** The planner's previous version, when it revised the plan (a person asked for changes). */
  readonly previous?: { readonly plan: Plan; readonly digest: string; readonly at: string };
  /** What changed since `previous`, by step id (`step added: S3`, `step S1 changed: intent`). */
  readonly changes?: readonly string[];
}

export interface SystemPlanSummary {
  readonly id: string;
  readonly task: string;
  readonly status: SystemPlan["status"];
  /** How many steps, and how many are done. */
  readonly steps: number;
  readonly done: number;
  readonly approval?: { readonly by: string; readonly at: string; readonly stale: boolean };
  /** When it last changed: its last recorded edit, else its approval; null when nothing says. */
  readonly updatedAt: string | null;
}

export interface SystemPlanStepView {
  readonly id: string;
  readonly app: string;
  /** Where the application's code is on this machine, or what the map says when it has no checkout. */
  readonly repo: string;
  /** What the step does (its summary). */
  readonly task: string;
  readonly dependsOn: readonly string[];
  readonly status: SystemPlan["steps"][number]["status"];
  readonly run?: string;
  /** The child run's status, when it can be read. */
  readonly runState?: string;
  /** The child run's stage, when it can be read. */
  readonly runStage?: string;
}

/** `GET /system/plans/:plan`. */
export interface SystemPlanView {
  readonly plan: SystemPlan;
  readonly digest: string;
  readonly status: SystemPlan["status"];
  readonly lint: PlanLintView;
  readonly approval?: {
    readonly by: string;
    readonly at: string;
    readonly digest: string;
    readonly stale: boolean;
  };
  /** The deploy order: empty when the steps depend on each other in a circle (lint says so). */
  readonly waves: readonly { readonly wave: number; readonly steps: readonly string[] }[];
  readonly steps: readonly SystemPlanStepView[];
  readonly editable: boolean;
  readonly readOnlyBecause?: string;
  /** The plan's file, relative to the repository. */
  readonly file: string;
  /** The planner's previous version, when it revised the plan. */
  readonly previous?: { readonly plan: SystemPlan; readonly digest: string; readonly at: string };
  /** What changed since `previous`, by step id. */
  readonly changes?: readonly string[];
}

/** `GET /system/map`. */
export interface SystemMapView {
  readonly map: SystemMap | null;
  readonly digest: string | null;
  readonly lint: PlanLintView;
  /** Where the applications' code is on this machine (`system.roots` and the checkouts found). */
  readonly roots: readonly string[];
  readonly file: string;
  /** False when the map is pinned in another repository: it is read here, changed there. */
  readonly editable: boolean;
  readonly readOnlyBecause?: string;
}

/** `POST /system/discover`. */
export interface SystemDiscoveryView {
  readonly proposed: SystemMap;
  /** What the map lacks that the code shows. */
  readonly changes: readonly string[];
  readonly written: boolean;
  readonly file?: string;
  /** Whether the place has a map yet: without one, a write creates it from the proposal. */
  readonly mapExists?: boolean;
}

/** The digest a write names: of the document's body, so formatting and key order do not count. */
export const documentDigest = (body: unknown): string => digestOf(body);

/**
 * A body sent by the app, as its document: with or without the header (`kind`, `schemaVersion`),
 * which a client may drop. What does not fit the schema comes back as problems, one per field.
 */
export function documentFromBody<T>(
  doc: VersionedDocument<T>,
  raw: unknown,
  source: string,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: PlanLintProblem[] } {
  const given = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
  if (!given)
    return { ok: false, problems: [{ severity: "error", field: "(root)", message: "expected an object" }] };
  const withHeader =
    "kind" in given ? given : { kind: doc.kind, schemaVersion: doc.current, ...(given as object) };
  const parsed = doc.parse(withHeader, source);
  if (parsed.isOk()) return { ok: true, value: parsed.value };
  const issues = (parsed.error.details?.issues ?? []) as { path: string; message: string }[];
  return {
    ok: false,
    problems:
      issues.length > 0
        ? issues.map((i) => ({ severity: "error" as const, field: i.path, message: i.message }))
        : [{ severity: "error", field: "(root)", message: parsed.error.message }],
  };
}

/**
 * What changed between two lists of items with ids, as lines a person reads: the items added and
 * removed, the ones whose fields changed (naming the fields), and whether the rest moved.
 */
export function itemChanges<T extends { readonly id: string }>(
  noun: string,
  before: readonly T[],
  after: readonly T[],
): string[] {
  const was = new Map(before.map((s) => [s.id, s]));
  const now = new Map(after.map((s) => [s.id, s]));
  const out: string[] = [];
  const added = after.filter((s) => !was.has(s.id)).map((s) => s.id);
  const removed = before.filter((s) => !now.has(s.id)).map((s) => s.id);
  if (added.length > 0) out.push(`${noun} added: ${added.join(", ")}`);
  if (removed.length > 0) out.push(`${noun} removed: ${removed.join(", ")}`);
  for (const s of after) {
    const old = was.get(s.id);
    if (!old) continue;
    const keys = [...new Set([...Object.keys(old), ...Object.keys(s)])].sort();
    const fields = keys.filter(
      (k) => digestOf((old as Record<string, unknown>)[k]) !== digestOf((s as Record<string, unknown>)[k]),
    );
    if (fields.length > 0) out.push(`${noun} ${s.id} changed: ${fields.join(", ")}`);
  }
  const kept = (list: readonly T[]) => list.map((s) => s.id).filter((id) => was.has(id) && now.has(id));
  if (kept(before).join("\u0000") !== kept(after).join("\u0000")) out.push(`${noun}s reordered`);
  return out;
}

/** What changed in the fields of a document besides its lists (`task`, `scope`), by name. */
export function fieldChanges(before: object, after: object, fields: readonly string[]): string[] {
  const changed = fields.filter(
    (f) =>
      digestOf((before as Record<string, unknown>)[f]) !== digestOf((after as Record<string, unknown>)[f]),
  );
  return changed.length > 0 ? [`changed: ${changed.join(", ")}`] : [];
}

/** The changes as one line: `step S3 added; step S1 changed: intent`, or that nothing changed. */
export const changeSummary = (changes: readonly string[]): string =>
  changes.length > 0 ? changes.join("; ") : "nothing changed";

/**
 * One edit a person made, a line of a plan's or the map's edit log (`<file>.edits.jsonl`): who,
 * when, the digests before and after, what changed. A run plan's edits are in the run's activity.
 */
export const PlanEditSchema = z.strictObject({
  at: z.iso.datetime(),
  by: z.string().min(1),
  target: z.enum(["system-plan", "system-map"]),
  /** The plan's id, or the map's file. */
  id: z.string().min(1),
  before: z.string().nullable(),
  after: z.string(),
  changes: z.array(z.string()),
  /** The approval an edit made stale: the plan went back to draft. */
  unapproved: z.strictObject({ by: z.string(), at: z.string() }).optional(),
  note: z.string().optional(),
});
export type PlanEdit = z.output<typeof PlanEditSchema>;

export const PlanEditDocument = defineDocument("PlanEdit", {
  latest: PlanEditSchema,
  hint: "Written by MetatorAI when a person edits a plan or the system map; one versioned JSON object per line.",
});

/** Where a document's edit log is: next to it, `<file without extension>.edits.jsonl`. */
export const editLogOf = (file: string): string => `${file.replace(/\.[^./]+$/, "")}.edits.jsonl`;

/** A conflict's message: the document changed since the client read it. */
export const staleDigest = (what: string): string =>
  `${what} changed since you read it: reload, then make your change again`;

/**
 * The version of a plan its planner replaced (kept when the run went back to the plan's stage):
 * the plan as it was, its digest, and when it was kept.
 */
const PlanRevisionSchema = z.strictObject({
  at: z.iso.datetime(),
  digest: z.string().min(1),
  plan: z.record(z.string(), z.unknown()),
});
export type PlanRevision = z.output<typeof PlanRevisionSchema>;

export const PlanRevisionDocument = defineDocument("PlanRevision", {
  latest: PlanRevisionSchema,
  hint: "Written by MetatorAI when a run goes back to its plan's stage: the plan its planner is to revise.",
});

/** Where the previous version of a plan file is kept: next to it, `<file without extension>.previous.json`. */
export const previousOf = (file: string): string => `${file.replace(/\.[^./]+$/, "")}.previous.json`;
