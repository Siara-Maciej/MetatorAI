import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/** What the metrics read of a question (the `Question` document carries more). */
export interface AskedQuestion {
  readonly source: string;
  readonly agent?: string | undefined;
  readonly askedAt: string;
  readonly answer?: { readonly by: string; readonly at: string } | undefined;
}

/**
 * Telemetry (P6): what each agent call cost, and what the run cost a person. One line of
 * `.metator/runs/<id>/usage.jsonl` per agent call; a host that reports no tokens leaves them out.
 */
export const AgentUsageSchema = z.strictObject({
  at: z.iso.datetime(),
  stage: z.string(),
  agent: z.string(),
  ok: z.boolean(),
  /** Wall time of the call. */
  durationMs: z.number().int().min(0),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  /** Input read from the host's prompt cache. */
  cachedTokens: z.number().int().min(0).optional(),
  /** What the host says the call cost, in US dollars. */
  costUsd: z.number().min(0).optional(),
});
export type AgentUsage = z.output<typeof AgentUsageSchema>;

export const AgentUsageDocument = defineDocument("AgentUsage", {
  latest: AgentUsageSchema,
  hint: "Written by `metator run drive`; one versioned JSON object per line.",
});

/** What a host reports about one call, when it reports anything. */
export interface HostUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly costUsd?: number;
}

export interface Totals {
  readonly calls: number;
  readonly agentMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly costUsd: number;
}

const zero: Totals = { calls: 0, agentMs: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };

function add(t: Totals, u: AgentUsage): Totals {
  return {
    calls: t.calls + 1,
    agentMs: t.agentMs + u.durationMs,
    inputTokens: t.inputTokens + (u.inputTokens ?? 0),
    outputTokens: t.outputTokens + (u.outputTokens ?? 0),
    cachedTokens: t.cachedTokens + (u.cachedTokens ?? 0),
    costUsd: round(t.costUsd + (u.costUsd ?? 0)),
  };
}

const round = (usd: number) => Math.round(usd * 10_000) / 10_000;

/** One run's numbers: what it cost, what it asked of people, how often its gates sent it back. */
export interface RunMetrics {
  readonly runId: string;
  readonly workflow: string;
  readonly status: string;
  readonly wallMs: number;
  readonly usage: Totals;
  readonly questions: {
    readonly asked: number;
    /** Answered by an answer policy, not a person. */
    readonly byPolicy: number;
    readonly bySource: Readonly<Record<string, number>>;
    /** How long questions waited for a person, summed (open ones up to now). */
    readonly waitMs: number;
  };
  /** Gates and reviews that sent the run back (FAIL transitions). */
  readonly failures: number;
}

export interface RunFacts {
  readonly runId: string;
  readonly workflow: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history: readonly { readonly event: string }[];
  readonly questions: readonly AskedQuestion[];
  readonly usage: readonly AgentUsage[];
}

export function runMetrics(run: RunFacts, now: Date): RunMetrics {
  const end = run.status === "active" ? now.getTime() : new Date(run.updatedAt).getTime();
  const bySource: Record<string, number> = {};
  let waitMs = 0;
  let byPolicy = 0;
  for (const q of run.questions) {
    bySource[q.source] = (bySource[q.source] ?? 0) + 1;
    if (q.answer?.by.startsWith("policy:")) {
      byPolicy++;
      continue;
    }
    const answered = q.answer ? new Date(q.answer.at).getTime() : now.getTime();
    waitMs += Math.max(0, answered - new Date(q.askedAt).getTime());
  }
  return {
    runId: run.runId,
    workflow: run.workflow,
    status: run.status,
    wallMs: Math.max(0, end - new Date(run.createdAt).getTime()),
    usage: run.usage.reduce(add, zero),
    questions: { asked: run.questions.length, byPolicy, bySource, waitMs },
    failures: run.history.filter((h) => h.event === "FAIL").length,
  };
}

/** One agent across runs: what it costs, how often it fails, how often it stops to ask. */
export interface AgentMetrics extends Totals {
  readonly agent: string;
  readonly failed: number;
  /** Questions it asked a person (or a policy), permission questions included. */
  readonly questions: number;
}

/** The report over many runs (`metator report`): totals, each run, each agent. */
export interface FleetReport {
  readonly runs: readonly RunMetrics[];
  readonly totals: Totals & {
    readonly runs: number;
    readonly done: number;
    readonly questions: number;
    readonly byPolicy: number;
    readonly personWaitMs: number;
    readonly failures: number;
  };
  readonly agents: readonly AgentMetrics[];
}

export function fleetReport(runs: readonly RunFacts[], now: Date): FleetReport {
  const metrics = runs.map((r) => runMetrics(r, now));
  const agents = new Map<string, AgentMetrics>();
  const agentOf = (name: string) => agents.get(name) ?? { agent: name, ...zero, failed: 0, questions: 0 };
  for (const r of runs) {
    for (const u of r.usage) {
      const a = agentOf(u.agent);
      agents.set(u.agent, { ...a, ...add(a, u), failed: a.failed + (u.ok ? 0 : 1) });
    }
    for (const q of r.questions)
      if (q.agent) {
        const a = agentOf(q.agent);
        agents.set(q.agent, { ...a, questions: a.questions + 1 });
      }
  }
  const usage = runs.flatMap((r) => r.usage).reduce(add, zero);
  return {
    runs: metrics,
    totals: {
      ...usage,
      runs: runs.length,
      done: metrics.filter((m) => m.status === "done").length,
      questions: metrics.reduce((n, m) => n + m.questions.asked, 0),
      byPolicy: metrics.reduce((n, m) => n + m.questions.byPolicy, 0),
      personWaitMs: metrics.reduce((n, m) => n + m.questions.waitMs, 0),
      failures: metrics.reduce((n, m) => n + m.failures, 0),
    },
    agents: [...agents.values()].sort(
      (a, b) => b.costUsd - a.costUsd || b.agentMs - a.agentMs || a.agent.localeCompare(b.agent),
    ),
  };
}

/** The acceptance figures of the desktop (spec §9, 11a and 11b), from the same facts as the report. */
export interface AcceptanceStats {
  /** Questions a person answered (policies aside). */
  readonly answered: number;
  /** The median time from a question to its answer by a person, undefined without an answer. */
  readonly medianAnswerMs?: number;
  /** Answers given from the decision card without opening the session, and all answers by a person. */
  readonly fromInbox: number;
  /** Restarts the supervisor made and idle nudges it sent since `since`. */
  readonly restarts: number;
  readonly nudges: number;
}

/**
 * 11a from the questions (how long people take, how many answers came from the card) and 11b
 * from the activity (restarts and nudges since `since`): deterministic, never from a model.
 */
export function acceptanceStats(
  runs: readonly {
    readonly questions: readonly AskedQuestion[];
    readonly activity: readonly {
      readonly at: string;
      readonly type: string;
      readonly origin?: string | undefined;
    }[];
  }[],
  since: string,
): AcceptanceStats {
  const delays: number[] = [];
  let fromInbox = 0;
  let restarts = 0;
  let nudges = 0;
  for (const r of runs) {
    for (const q of r.questions)
      if (q.answer && !q.answer.by.startsWith("policy:"))
        delays.push(Math.max(0, new Date(q.answer.at).getTime() - new Date(q.askedAt).getTime()));
    for (const a of r.activity) {
      if (a.type === "answer" && a.origin === "inbox") fromInbox++;
      if (a.at < since) continue;
      if (a.type === "restart") restarts++;
      if (a.type === "idle") nudges++;
    }
  }
  delays.sort((a, b) => a - b);
  const mid = delays.length >> 1;
  const median =
    delays.length === 0
      ? undefined
      : delays.length % 2 === 1
        ? (delays[mid] as number)
        : ((delays[mid - 1] as number) + (delays[mid] as number)) / 2;
  return {
    answered: delays.length,
    ...(median !== undefined ? { medianAnswerMs: median } : {}),
    fromInbox,
    restarts,
    nudges,
  };
}
