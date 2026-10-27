import { z } from "zod";
import { criticalPath, type Environment } from "./environment.ts";
import { defineDocument } from "./versioned.ts";

/**
 * What a start costs, measured by `env analyze` (F8.7, ADR-0055): every phase of every service in
 * a cold start and in a second, warm worktree, the critical path and recommendations with the
 * time they would save. A recommendation is a proposal; a person moves it into environment.yml.
 */
const Id = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const PhaseSchema = z.strictObject({ name: z.string().min(1), ms: z.number().int().nonnegative() });
export type Phase = z.output<typeof PhaseSchema>;

const MeasuredService = z.strictObject({
  scope: z.enum(["shared", "worktree", "on-demand"]),
  /** "measured": it started in this start; "running": it was already up and was reused. */
  status: z.enum(["measured", "running"]),
  phases: z.array(PhaseSchema),
  ms: z.number().int().nonnegative(),
});

const StartSchema = z.strictObject({
  worktree: z.string().min(1),
  ms: z.number().int().nonnegative(),
  services: z.record(Id, MeasuredService),
});
export type MeasuredStart = z.output<typeof StartSchema>;

const RecommendationSchema = z.strictObject({
  id: z.enum(["reuse-build", "template-database", "warm-pool", "partial-start", "cold-measure"]),
  service: Id.optional(),
  message: z.string().min(1),
  /** The measurement it rests on. */
  evidence: z.string().min(1),
  /** Estimated time saved per new worktree. */
  gainMs: z.number().int().nonnegative(),
  /** What to change: an environment.yml fragment or a command. */
  apply: z.string().min(1),
});
export type Recommendation = z.output<typeof RecommendationSchema>;

export const EnvProfileSchema = z.strictObject({
  measuredAt: z.iso.datetime(),
  cold: StartSchema,
  warm: StartSchema,
  /** cold.ms / warm.ms, one decimal. */
  speedup: z.number().nonnegative(),
  /** Shared services were already running, so the cold start did not pay for them. */
  sharedWarm: z.boolean(),
  criticalPath: z.array(Id),
  recommendations: z.array(RecommendationSchema),
});
export type EnvProfile = z.output<typeof EnvProfileSchema>;

export const EnvProfileDocument = defineDocument("EnvProfile", {
  latest: EnvProfileSchema,
  hint: "Written by `metator env analyze`; run it again to measure anew.",
});

const SLOW_STEP_MS = 1000;
const SLOW_WARM_MS = 10_000;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The profile of two measured starts, with the recommendations the measurements support. */
export function buildProfile(
  env: Environment,
  cold: MeasuredStart,
  warm: MeasuredStart,
  at: Date,
): EnvProfile {
  const sharedWarm = Object.values(cold.services).some((s) => s.scope === "shared" && s.status === "running");
  const ms = Object.fromEntries(Object.entries(cold.services).map(([id, s]) => [id, s.ms]));
  const path = criticalPath(env, ms);
  return {
    measuredAt: at.toISOString(),
    cold,
    warm,
    speedup: warm.ms === 0 ? 0 : Math.round((cold.ms / warm.ms) * 10) / 10,
    sharedWarm,
    criticalPath: path,
    recommendations: recommend(env, cold, warm, path, sharedWarm),
  };
}

function recommend(
  env: Environment,
  cold: MeasuredStart,
  warm: MeasuredStart,
  path: readonly string[],
  sharedWarm: boolean,
): Recommendation[] {
  const out: Recommendation[] = [];
  if (sharedWarm)
    out.push({
      id: "cold-measure",
      message: "Shared services were already running, so their start was not measured",
      evidence: `running before the analysis: ${Object.entries(cold.services)
        .filter(([, s]) => s.status === "running")
        .map(([id]) => id)
        .join(", ")}`,
      gainMs: 0,
      apply: "metator env analyze --cold",
    });
  for (const [id, measured] of Object.entries(warm.services)) {
    const s = env.services[id];
    if (!s || s.scope === "shared") continue;
    for (const step of s.prepare) {
      const phase = measured.phases.find((p) => p.name === step.name);
      if (!phase || phase.ms < SLOW_STEP_MS || s.warm) continue;
      out.push({
        id: "reuse-build",
        service: id,
        message: `Reuse what \`${step.name}\` produces from the main checkout instead of redoing it per worktree`,
        evidence: `${id}: ${step.name} took ${seconds(phase.ms)} in a new worktree`,
        gainMs: phase.ms,
        apply: `services.${id}.warm: { reuse: [node_modules] }   # and the build output directories`,
      });
    }
    const shared = s.needs.find((n) => env.services[n]?.scope === "shared" && !env.services[n]?.isolate);
    for (const step of s.init) {
      const phase = measured.phases.find((p) => p.name === step.name);
      if (!phase || phase.ms < SLOW_STEP_MS || !shared) continue;
      out.push({
        id: "template-database",
        service: id,
        message: `Run \`${step.name}\` once into a template database and clone it per worktree`,
        evidence: `${id}: ${step.name} took ${seconds(phase.ms)} in every new worktree; cloning a template takes seconds`,
        gainMs: phase.ms,
        apply: `services.${shared}: { init: [{ name: ${step.name}, run: "…" }], isolate: { postgres: { template: app_seed, database: app } } }`,
      });
    }
  }
  if (warm.ms >= SLOW_WARM_MS)
    out.push({
      id: "warm-pool",
      message: "Keep worktrees with their services already started; a new run takes one",
      evidence: `a second worktree still takes ${seconds(warm.ms)} to start`,
      gainMs: warm.ms,
      apply: "metator env pool --size 2",
    });
  const offPath = Object.entries(warm.services).filter(
    ([id, m]) => m.scope !== "shared" && !path.includes(id) && env.services[id]?.paths.length === 0,
  );
  if (offPath.length >= 2)
    out.push({
      id: "partial-start",
      message: "Declare each service's `paths` and start only what a change touches",
      evidence: `${offPath.map(([id, m]) => `${id} ${seconds(m.ms)}`).join(", ")} start in every worktree`,
      gainMs: offPath.reduce((n, [, m]) => n + m.ms, 0),
      apply: "services.<id>.paths: [apps/<id>]   then   metator env up --affected",
    });
  return out.sort((a, b) => b.gainMs - a.gainMs);
}
