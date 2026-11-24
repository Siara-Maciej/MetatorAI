/**
 * Editing a plan in the app, pure (ADR-0087 on the daemon's side): the run's implementation plan,
 * a system plan and the system map. The editor keeps a draft; these functions change it, say what
 * changed before a save, turn it to text and back, and decide what a conflict leaves.
 */
import type {
  Plan,
  PlanLintProblem,
  PlanStep,
  SystemMap,
  SystemPlan,
  SystemStep,
} from "../../shared/api/api.ts";

/** A list typed in one field: `a, b` → `["a", "b"]`; empty pieces are dropped. */
export const listOf = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");

export const textOf = (list: readonly string[] | undefined): string => (list ?? []).join(", ");

/** The next id of a list whose ids are a prefix and a number: `S3` after `S1, S2`. */
export function nextId(ids: readonly string[], prefix: string): string {
  const numbers = ids.map((id) => Number(id.startsWith(prefix) ? id.slice(prefix.length) : Number.NaN));
  const max = Math.max(0, ...numbers.filter((n) => Number.isInteger(n)));
  return `${prefix}${max + 1}`;
}

/** A list with one item moved one place up (-1) or down (+1); at an end it stays. */
export function moved<T>(list: readonly T[], index: number, step: -1 | 1): T[] {
  const to = index + step;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(index, 1);
  out.splice(to, 0, item as T);
  return out;
}

/* ---------- the run's implementation plan ---------- */

/** A new step at the end: modify a file, with nothing filled in but its id. */
export const blankStep = (plan: Pick<Plan, "steps">): PlanStep =>
  ({
    id: nextId(
      plan.steps.map((s) => s.id),
      "S",
    ),
    action: "modify",
    path: "",
    intent: "",
    rules: [],
    testsFirst: [],
    dependsOn: [],
  }) as PlanStep;

export const withStep = <P extends Pick<Plan, "steps">>(plan: P, step: PlanStep = blankStep(plan)): P => ({
  ...plan,
  steps: [...plan.steps, step],
});

/** A plan without a step; no other step still waits on it. */
export const withoutStep = <P extends Pick<Plan, "steps">>(plan: P, id: string): P => ({
  ...plan,
  steps: plan.steps
    .filter((s) => s.id !== id)
    .map((s) => (s.dependsOn.includes(id) ? { ...s, dependsOn: s.dependsOn.filter((d) => d !== id) } : s)),
});

export const withStepMoved = <P extends Pick<Plan, "steps">>(plan: P, id: string, step: -1 | 1): P => ({
  ...plan,
  steps: moved(
    plan.steps,
    plan.steps.findIndex((s) => s.id === id),
    step,
  ),
});

/**
 * A plan with one step's fields changed. The step's exemplar lives in its `patternSource`: a new
 * exemplar keeps the pattern's name and reason (or asks for them, empty), an empty one drops it.
 */
export function withStepChanged<P extends Pick<Plan, "steps">>(
  plan: P,
  id: string,
  patch: Partial<Omit<PlanStep, "patternSource">> & { readonly exemplar?: string },
): P {
  return {
    ...plan,
    steps: plan.steps.map((s) => {
      if (s.id !== id) return s;
      const { exemplar, ...rest } = patch;
      const next = { ...s, ...rest } as PlanStep;
      if (exemplar === undefined) return next;
      if (exemplar.trim() === "") {
        const { patternSource: _drop, ...without } = next;
        return without as PlanStep;
      }
      return {
        ...next,
        patternSource: {
          pattern: s.patternSource?.pattern ?? "",
          reason: s.patternSource?.reason ?? "",
          exemplar: exemplar.trim(),
        },
      } as PlanStep;
    }),
  };
}

/* ---------- a system plan ---------- */

/** A new step of a system plan: an id `step-N`, the first application, nothing else. */
export const blankSystemStep = (plan: Pick<SystemPlan, "steps">, app = ""): SystemStep =>
  ({
    id: nextId(
      plan.steps.map((s) => s.id),
      "step-",
    ),
    app,
    summary: "",
    contracts: [],
    dependsOn: [],
    status: "pending",
  }) as SystemStep;

/** A step that already has a run is history: the daemon refuses to change or remove it. */
export const stepLocked = (s: Pick<SystemStep, "run">): boolean => s.run !== undefined;

export const withSystemStep = (plan: SystemPlan, step: SystemStep = blankSystemStep(plan)): SystemPlan => ({
  ...plan,
  steps: [...plan.steps, step],
});

export function withoutSystemStep(plan: SystemPlan, id: string): SystemPlan {
  const step = plan.steps.find((s) => s.id === id);
  if (!step || stepLocked(step)) return plan;
  return {
    ...plan,
    steps: plan.steps
      .filter((s) => s.id !== id)
      .map((s) => (s.dependsOn.includes(id) ? { ...s, dependsOn: s.dependsOn.filter((d) => d !== id) } : s)),
  };
}

export const withSystemStepMoved = (plan: SystemPlan, id: string, step: -1 | 1): SystemPlan => ({
  ...plan,
  steps: moved(
    plan.steps,
    plan.steps.findIndex((s) => s.id === id),
    step,
  ),
});

export function withSystemStepChanged(
  plan: SystemPlan,
  id: string,
  patch: Partial<Pick<SystemStep, "id" | "app" | "summary" | "dependsOn">>,
): SystemPlan {
  return {
    ...plan,
    steps: plan.steps.map((s) => (s.id === id && !stepLocked(s) ? { ...s, ...patch } : s)),
  };
}

/* ---------- the system map ---------- */

export type MapApplication = SystemMap["applications"][number];
export type MapContract = SystemMap["contracts"][number];

export const blankApplication = (map: Pick<SystemMap, "applications">): MapApplication =>
  ({
    id: nextId(
      map.applications.map((a) => a.id),
      "app-",
    ),
    kind: "service",
    source: { path: "." },
    owners: [],
    consumes: [],
  }) as MapApplication;

export const blankContract = (map: Pick<SystemMap, "contracts" | "applications">): MapContract =>
  ({
    id: nextId(
      map.contracts.map((c) => c.id),
      "contract-",
    ),
    kind: "openapi",
    owner: map.applications[0]?.id ?? "",
    spec: { path: "openapi.yaml" },
    compatibility: "backward",
  }) as MapContract;

/**
 * Where an application's code is, as one field: a path in this repository (`apps/web`), or
 * another repository written `repo:<repo>[@<ref>][:<path>]`.
 */
export function sourceText(source: MapApplication["source"]): string {
  if ("repo" in source && source.repo !== undefined)
    return `repo:${source.repo}${source.ref ? `@${source.ref}` : ""}${source.path ? `:${source.path}` : ""}`;
  return source.path ?? "";
}

export function sourceOf(text: string): MapApplication["source"] {
  const t = text.trim();
  const m = /^repo:([^@:\s]+)(?:@([^:\s]+))?(?::(.+))?$/.exec(t);
  if (m) return { repo: m[1] as string, ...(m[2] ? { ref: m[2] } : {}), ...(m[3] ? { path: m[3] } : {}) };
  return { path: t === "" ? "." : t };
}

/* ---------- what changed, text, conflicts ---------- */

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What changed between two lists of items with ids, in words: added, removed, the fields that
 * changed on the others, and whether the ones kept moved.
 */
export function itemChangeLines<T extends { readonly id: string }>(
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
      (k) => !same((old as Record<string, unknown>)[k], (s as Record<string, unknown>)[k]),
    );
    if (fields.length > 0) out.push(`${noun} ${s.id} changed: ${fields.join(", ")}`);
  }
  const kept = (list: readonly T[]) => list.map((s) => s.id).filter((id) => was.has(id) && now.has(id));
  if (!same(kept(before), kept(after))) out.push(`${noun}s reordered`);
  return out;
}

/** The fields of a document besides its lists that changed, by name. */
export function fieldChangeLines(before: object, after: object, fields: readonly string[]): string[] {
  const changed = fields.filter(
    (f) => !same((before as Record<string, unknown>)[f], (after as Record<string, unknown>)[f]),
  );
  return changed.length > 0 ? [`changed: ${changed.join(", ")}`] : [];
}

/** What a save of a run plan changes, before it is saved. */
export const planChanges = (before: Plan, after: Plan): string[] => [
  ...fieldChangeLines(before, after, ["task", "scope"]),
  ...itemChangeLines("step", before.steps, after.steps),
];

/** What a save of a system plan changes. */
export const systemPlanChanges = (before: SystemPlan, after: SystemPlan): string[] => [
  ...fieldChangeLines(before, after, ["task", "strategies"]),
  ...itemChangeLines("step", before.steps, after.steps),
];

/** What a save of the system map changes. */
export const mapChanges = (before: SystemMap, after: SystemMap): string[] => [
  ...fieldChangeLines(before, after, ["system", "policies"]),
  ...itemChangeLines("application", before.applications, after.applications),
  ...itemChangeLines("contract", before.contracts, after.contracts),
];

/** A document as the text a person edits: the header left out (the daemon adds it back). */
export function documentText(doc: unknown): string {
  if (doc === null || typeof doc !== "object") return "{}";
  const { kind: _kind, schemaVersion: _version, ...body } = doc as Record<string, unknown>;
  return JSON.stringify(body, null, 2);
}

/** Text typed by a person back to a document, or where it does not parse (with the line). */
export function parseDocumentText(
  text: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: PlanLintProblem } {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return {
        ok: false,
        problem: { severity: "error", field: "(root)", message: "expected an object { … }" },
      };
    return { ok: true, value };
  } catch (e) {
    const message = (e as Error).message;
    // Chromium says where (`at position 21`, `line 3 column 3`); other engines may not.
    const at = /position (\d+)/.exec(message);
    const named = /line (\d+)/.exec(message);
    const line = named ? Number(named[1]) : at ? text.slice(0, Number(at[1])).split("\n").length : undefined;
    return {
      ok: false,
      problem: {
        severity: "error",
        field: line !== undefined ? `line ${line}` : "(text)",
        message: `not valid JSON: ${message}`,
      },
    };
  }
}

/**
 * The problems a refused save answered with (400 USAGE, `details.problems`), or none; a save is
 * not refused for lint, only for a document that does not fit its schema.
 */
export function refusedProblems(details: Readonly<Record<string, unknown>> | undefined): PlanLintProblem[] {
  const list = details?.problems;
  return Array.isArray(list) ? (list as PlanLintProblem[]) : [];
}

/** A write based on an old version (409 CONFLICT): the document as it is now, from `details.current`. */
export function conflictCurrent<V>(
  error: { readonly code?: string; readonly details?: Readonly<Record<string, unknown>> } | undefined,
): V | undefined {
  return error?.code === "CONFLICT" ? (error.details?.current as V | undefined) : undefined;
}
