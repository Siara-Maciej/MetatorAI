import { type MetatorError, type Result, reviewSourcesOf, type Supervisor } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";

/**
 * What the daemon does on its own, on a clock: the supervisor's tick (dead drives, idle agents),
 * the intake scan (T2), the reviews of my requests (T3) and closing the panes of finished runs,
 * each for every repository it serves. What they find goes to stderr as one JSON line; a run they
 * start is driven.
 */
export interface TimerDeps {
  /** The repositories the daemon serves, by the name a request names them (`undefined`: the only one). */
  readonly repos: () => readonly (string | undefined)[];
  /**
   * The ones that look for intake issues and review requests (default: all). A worktree checkout
   * shares its repository's issues and requests, so only the repository looks, once.
   */
  readonly scans?: () => readonly (string | undefined)[];
  readonly containerFor: (repo: string | undefined) => Result<MetatorContainer, unknown>;
  readonly superviseMs: number;
  /** How often to scan the intake rules: a fixed interval, or each repository's own `intake.everyMs`. */
  readonly intakeMs: number | "own";
  /** How often to read the reviews of my requests: fixed, or each repository's own `reviews.everyMs`. */
  readonly reviewsMs: number | "own";
  /** How often to look at watched MRs (ADR-0097): fixed, or each repository's own `codehost.review.everyMs`. */
  readonly watchMs?: number | "own";
  /** How often the panes of runs that finished are ended (0: never). */
  readonly sweepMs?: number;
  /** How often every live pane's screen is kept on disk (0: never), so a SIGKILL loses little. */
  readonly screensMs?: number;
  /** How the supervisor starts a drive again. */
  readonly restart?: (
    c: MetatorContainer,
    runId: string,
  ) => Promise<Result<{ readonly stage: string }, MetatorError>>;
}

/** One repository's interval: the fixed one, or what its own config says (`own`). */
export function intervalOf(given: number | "own", own: number): number {
  return given === "own" ? own : given;
}

export function startTimers(deps: TimerDeps): { stop(): void } {
  const each = (work: (key: string, c: MetatorContainer) => void, repos = deps.repos) => {
    for (const repo of repos()) {
      const c = deps.containerFor(repo);
      if (c.isOk()) work(repo ?? ".", c.value);
    }
  };
  const say = (what: string, key: string) => (o: object) =>
    process.stderr.write(`${JSON.stringify({ [what]: { repo: key, ...o } })}\n`);
  const timers: ReturnType<typeof setInterval>[] = [];

  // The supervisor: one tick per interval for every repository the daemon serves.
  const supervisors = new Map<string, Supervisor>();
  const restart = deps.restart;
  if (deps.superviseMs > 0 && restart)
    timers.push(
      setInterval(
        () =>
          each((key, c) => {
            const s = supervisors.get(key) ?? c.resolve("supervisor")((runId) => restart(c, runId));
            supervisors.set(key, s);
            void s.tick().then((r) => {
              if (r.isErr()) say("supervisor", key)({ error: r.error.message });
            });
          }),
        deps.superviseMs,
      ),
    );

  // Intake (T2) and reviews (T3): each repository on its own interval (a folder's repositories
  // each keep their own `everyMs`); a run either starts is driven.
  const busy = new Set<string>();
  const once = (what: string, key: string, work: () => Promise<unknown>) => {
    const k = `${what}:${key}`;
    if (busy.has(k)) return;
    busy.add(k);
    void work().finally(() => busy.delete(k));
  };
  const intake = (key: string, c: MetatorContainer) =>
    once("intake", key, async () => {
      const tell = say("intake", key);
      const r = await c.resolve("scanIntake").execute();
      if (r.isErr()) return tell({ error: r.error.message });
      for (const rule of r.value.rules) if (rule.error) tell({ rule: rule.rule, error: rule.error });
      for (const s of r.value.rules.flatMap((x) => x.started)) {
        tell({ started: s.runId, issue: s.issue });
        await c.resolve("ensureDriven").execute({ runId: s.runId });
      }
    });
  const reviews = (key: string, c: MetatorContainer) =>
    once("reviews", key, async () => {
      const tell = say("reviews", key);
      const r = await c.resolve("myReviews").scan();
      if (r.isErr()) return tell({ error: r.error.message });
      for (const e of r.value.errors) tell({ error: e });
      for (const q of r.value.requests) {
        if (!q.started) continue;
        tell({ started: q.started, request: q.id, threads: q.fresh.length });
        await c.resolve("ensureDriven").execute({ runId: q.started });
      }
    });
  // Someone else's MRs (ADR-0097): new commits, the author's replies, merged or closed, and the
  // requests that ask me for a review. Nothing starts by itself: what is new becomes a card.
  const watched = (key: string, c: MetatorContainer) =>
    once("watch", key, async () => {
      const tell = say("reviews", key);
      const r = await c.resolve("watchedReviews").check();
      if (r.isErr()) return tell({ error: r.error.message });
      for (const e of r.value.errors) tell({ error: e });
      for (const id of r.value.news) tell({ news: id });
      for (const id of r.value.requested) tell({ requested: id });
      for (const id of r.value.ended) tell({ ended: id });
    });
  each((key, c) => {
    const config = c.resolve("config").config;
    const intakeEvery = intervalOf(deps.intakeMs, config.intake.everyMs);
    if (config.intake.rules.length > 0 && intakeEvery > 0)
      timers.push(setInterval(() => intake(key, c), intakeEvery));
    const reviewsEvery = intervalOf(deps.reviewsMs, config.reviews.everyMs);
    if (reviewSourcesOf(config.codehost).length > 0 && reviewsEvery > 0)
      timers.push(setInterval(() => reviews(key, c), reviewsEvery));
    const watchEvery = intervalOf(deps.watchMs ?? "own", config.codehost.review.everyMs);
    if (config.codehost.review.watch && watchEvery > 0)
      timers.push(setInterval(() => watched(key, c), watchEvery));
  }, deps.scans ?? deps.repos);

  // Every live pane's screen on disk: a paused session shows what it left, even after a SIGKILL.
  if ((deps.screensMs ?? 0) > 0)
    timers.push(
      setInterval(
        () =>
          each((key, c) =>
            once("screens", key, async () => {
              const r = await c.resolve("panes").saveScreens();
              if (r.isErr()) say("panes", key)({ error: r.error.message });
            }),
          ),
        deps.screensMs,
      ),
    );

  // A run that finished (done, aborted): its panes end (a living process is stopped, the screen
  // kept); they stay until a person closes them, and its idle conductor no longer reads as waiting.
  if ((deps.sweepMs ?? 0) > 0)
    timers.push(
      setInterval(
        () =>
          each((key, c) =>
            once("sweep", key, async () => {
              const r = await c.resolve("panes").endFinished();
              if (r.isErr()) return say("panes", key)({ error: r.error.message });
              for (const x of r.value) say("panes", key)({ ended: x.ended, finished: x.runId });
              // The chat a task was given in learns what became of it.
              const told = await c.resolve("chatNotices").tick();
              if (told.isErr()) return say("chat", key)({ error: told.error.message });
              for (const t of told.value) say("chat", key)({ told: t.paneId, run: t.runId, event: t.event });
              // A thread keeps what became of its runs (ADR-0095): one fact per event.
              const noted = await c.resolve("threads").noteRuns();
              if (noted.isErr()) return say("threads", key)({ error: noted.error.message });
              for (const n of noted.value)
                say("threads", key)({ noted: n.thread, run: n.runId, event: n.event });
              // Lines that wait for an idle agent (the person's words relayed by the task's main
              // chat, the chat's note that the person talked to a session directly).
              const mailed = await c.resolve("paneMail").tick();
              if (mailed.isErr()) return say("mail", key)({ error: mailed.error.message });
              for (const m of mailed.value) say("mail", key)({ told: m.paneId, kind: m.kind });
              // A session the daemon resumed is told to go on, once it is idle at its prompt.
              const resumed = await c.resolve("resumeNotices").tick();
              if (resumed.isErr()) return say("resumed", key)({ error: resumed.error.message });
              for (const t of resumed.value) say("resumed", key)({ told: t.paneId, run: t.runId });
            }),
          ),
        deps.sweepMs,
      ),
    );

  return {
    stop: () => {
      for (const t of timers) clearInterval(t);
    },
  };
}
