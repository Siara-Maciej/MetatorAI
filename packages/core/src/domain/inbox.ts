import type { Question, RunActivity } from "./drive.ts";

/** One decision waiting for a person, with what it costs to leave it (P4). */
export interface InboxItem {
  readonly runId: string;
  readonly task: string;
  readonly stage: string;
  /** A live drive waits on it: the run stands still until it is answered. */
  readonly driving: boolean;
  readonly waitedMs: number;
  readonly question: Question;
}

/**
 * Every open question of every run, as one queue (the decision inbox): first the ones a live
 * drive waits on (the run stands still), then the ones that have waited longest.
 */
export function inboxOf(
  runs: readonly {
    readonly runId: string;
    readonly task: string;
    readonly driving: boolean;
    readonly questions: readonly Question[];
    /** The run's status; a run that is not active asks nothing any more (R3). */
    readonly status?: string;
  }[],
  now: Date,
): InboxItem[] {
  const items = runs.flatMap((r) =>
    r.questions
      .filter((q) => !q.answer && (r.status ?? "active") === "active")
      .map((q) => ({
        runId: r.runId,
        task: r.task,
        stage: q.stage,
        driving: r.driving,
        waitedMs: Math.max(0, now.getTime() - new Date(q.askedAt).getTime()),
        question: q,
      })),
  );
  return items.sort(byUrgency);
}

/** A run that escalated: it stands until a person resumes it or closes it (R9, F1). */
export interface EscalatedItem {
  readonly runId: string;
  readonly task: string;
  /** The stage it escalated from: where a resume puts it back. */
  readonly stage: string;
  /** Why it escalated: the failure its last transition recorded. */
  readonly reason?: string;
  readonly waitedMs: number;
  /** The two ways out, as commands. */
  readonly next: readonly string[];
}

/** The two ways out of an escalated run, as the commands a person runs. */
export const escalatedNext = (runId: string): string[] => [
  `metator run resume --run ${runId} --by <name> --drive`,
  `metator run close --run ${runId} --aborted --reason <why>`,
];

/** Every escalated run, the one waiting longest first. */
export function escalatedOf(
  runs: readonly {
    readonly runId: string;
    readonly task: string;
    readonly status: string;
    readonly stage: string;
    readonly reason?: string;
    readonly updatedAt: string;
  }[],
  now: Date,
): EscalatedItem[] {
  return runs
    .filter((r) => r.status === "escalated")
    .map((r) => ({
      runId: r.runId,
      task: r.task,
      stage: r.stage,
      ...(r.reason ? { reason: r.reason } : {}),
      waitedMs: Math.max(0, now.getTime() - new Date(r.updatedAt).getTime()),
      next: escalatedNext(r.runId),
    }))
    .sort((a, b) => b.waitedMs - a.waitedMs || a.runId.localeCompare(b.runId));
}

/** A decision a live drive waits on first, then the one waiting longest; ties in a stable order. */
export const byUrgency = (a: InboxItem, b: InboxItem): number =>
  Number(b.driving) - Number(a.driving) ||
  b.waitedMs - a.waitedMs ||
  `${a.runId}/${a.question.id}`.localeCompare(`${b.runId}/${b.question.id}`);

/** What happened in a run since a moment (a person's last look), from its activity alone. */
export interface RunBrief {
  readonly since: string;
  /** Transitions in order: "plan PASS", "review FAIL: …". */
  readonly transitions: readonly string[];
  /** Files agents wrote or edited (as the tools named them), each once. */
  readonly files: readonly string[];
  readonly answers: readonly string[];
  readonly questions: readonly string[];
  readonly errors: readonly string[];
  /** Tool calls agents made. */
  readonly tools: number;
  /** The last thing that happened, when anything did. */
  readonly last?: string;
}

const WRITTEN = /^(?:Edit|Write|MultiEdit) \{"file_path":"([^"]+)"/;

/** The brief of a run since `since` (an ISO time): generated from events, never by a model. */
export function briefOf(activity: readonly RunActivity[], since: string): RunBrief {
  const after = activity.filter((a) => a.at > since);
  const of = (type: RunActivity["type"]) => after.filter((a) => a.type === type);
  const files = new Set<string>();
  for (const t of of("tool")) {
    const path = WRITTEN.exec(t.text)?.[1];
    if (path) files.add(path);
  }
  const last = after.at(-1);
  return {
    since,
    transitions: of("advance").map((a) => `${a.stage ?? "?"} ${a.text}`),
    files: [...files],
    answers: of("answer").map((a) => a.text),
    questions: of("question").map((a) => a.text),
    errors: of("error").map((a) => a.text),
    tools: of("tool").length,
    ...(last ? { last: `${last.at} ${last.type}: ${last.text}` } : {}),
  };
}
