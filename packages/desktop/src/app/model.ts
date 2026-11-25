/**
 * The shell's own logic: back after a while away, new questions to notify, where Home goes after an answer.
 */
import type { Question, RunOverview } from "../shared/api/api.ts";

/** The next session that waits for a person after `current` (the `g` key), wrapping around. */
export function nextWaiting<R extends Pick<RunOverview, "runId" | "attention">>(
  runs: readonly R[],
  current: string | undefined,
): R | undefined {
  const waiting = runs.filter((r) => r.attention === "you");
  if (waiting.length === 0) return undefined;
  const i = waiting.findIndex((r) => r.runId === current);
  return waiting[(i + 1) % waiting.length];
}
/** A person is "back" when they were away this long (spec §6.8): the briefing opens first. */
export const AWAY_MS = 10 * 60 * 1000;
export const wasAway = (lastSeenAt: number | undefined, now: number): boolean =>
  lastSeenAt !== undefined && now - lastSeenAt >= AWAY_MS;
/** Questions of the state that were not there before: what a notification announces. */
export function newQuestions(
  before: readonly Pick<Question, "id" | "runId">[],
  after: readonly Pick<Question, "id" | "runId" | "prompt">[],
): Pick<Question, "id" | "runId" | "prompt">[] {
  const seen = new Set(before.map((q) => `${q.runId}/${q.id}`));
  return after.filter((q) => !seen.has(`${q.runId}/${q.id}`));
}
