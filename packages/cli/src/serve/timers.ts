import type { MetatorError, Result, Supervisor } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";

/**
 * What the daemon does on its own, on a clock: the supervisor's tick (dead drives, idle agents),
 * the intake scan (T2) and the reviews of my requests (T3), each for every repository it serves.
 * What they find goes to stderr as one JSON line; a run they start is driven.
 */
export interface TimerDeps {
  /** The repositories the daemon serves, by the name a request names them (`undefined`: the only one). */
  readonly repos: () => readonly (string | undefined)[];
  readonly containerFor: (repo: string | undefined) => Result<MetatorContainer, unknown>;
  readonly superviseMs: number;
  readonly intakeMs: number;
  readonly reviewsMs: number;
  /** How the supervisor starts a drive again. */
  readonly restart?: (
    c: MetatorContainer,
    runId: string,
  ) => Promise<Result<{ readonly stage: string }, MetatorError>>;
}

export function startTimers(deps: TimerDeps): { stop(): void } {
  const each = (work: (key: string, c: MetatorContainer) => void) => {
    for (const repo of deps.repos()) {
      const c = deps.containerFor(repo);
      if (c.isOk()) work(repo ?? ".", c.value);
    }
  };
  const say = (what: string, key: string) => (o: object) =>
    process.stderr.write(`${JSON.stringify({ [what]: { repo: key, ...o } })}\n`);

  // The supervisor: one tick per interval for every repository the daemon serves.
  const supervisors = new Map<string, Supervisor>();
  const restart = deps.restart;
  const supervise = () =>
    each((key, c) => {
      if (!restart) return;
      const s = supervisors.get(key) ?? c.resolve("supervisor")((runId) => restart(c, runId));
      supervisors.set(key, s);
      void s.tick().then((r) => {
        if (r.isErr()) say("supervisor", key)({ error: r.error.message });
      });
    });

  // Intake (T2): one scan per interval for every repository with rules; started runs are driven.
  const scanning = new Set<string>();
  const intake = () =>
    each((key, c) => {
      if (c.resolve("config").config.intake.rules.length === 0 || scanning.has(key)) return;
      scanning.add(key);
      const tell = say("intake", key);
      void c
        .resolve("scanIntake")
        .execute()
        .then(async (r) => {
          if (r.isErr()) return tell({ error: r.error.message });
          for (const rule of r.value.rules) if (rule.error) tell({ rule: rule.rule, error: rule.error });
          for (const s of r.value.rules.flatMap((x) => x.started)) {
            tell({ started: s.runId, issue: s.issue });
            await c.resolve("ensureDriven").execute({ runId: s.runId });
          }
        })
        .finally(() => scanning.delete(key));
    });

  // Reviews of my requests (T3): one scan per interval for every repository with sources.
  const reviewing = new Set<string>();
  const reviews = () =>
    each((key, c) => {
      if (c.resolve("config").config.reviews.sources.length === 0 || reviewing.has(key)) return;
      reviewing.add(key);
      const tell = say("reviews", key);
      void c
        .resolve("myReviews")
        .scan()
        .then(async (r) => {
          if (r.isErr()) return tell({ error: r.error.message });
          for (const e of r.value.errors) tell({ error: e });
          for (const q of r.value.requests) {
            if (!q.started) continue;
            tell({ started: q.started, request: q.id, threads: q.fresh.length });
            await c.resolve("ensureDriven").execute({ runId: q.started });
          }
        })
        .finally(() => reviewing.delete(key));
    });

  const timers = [
    deps.superviseMs > 0 && restart ? setInterval(supervise, deps.superviseMs) : undefined,
    deps.intakeMs > 0 ? setInterval(intake, deps.intakeMs) : undefined,
    deps.reviewsMs > 0 ? setInterval(reviews, deps.reviewsMs) : undefined,
  ];
  return {
    stop: () => {
      for (const t of timers) if (t) clearInterval(t);
    },
  };
}
