import { z } from "zod";
import { defineDocument } from "./versioned.ts";
import type { StageSpec } from "./workflow-spec.ts";

/**
 * Driving a run from the CLI (F8.3, ADR-0051): the CLI walks the stages, starts each worker
 * through an AI host, and asks a person at the gates. Three documents record it in the run directory.
 */

/** One stage's work for an AI host: which agent, with what message, where. */
export interface AgentTask {
  readonly agent: string;
  readonly prompt: string;
  /** Absolute directory the agent works in (the run's worktree, or the repository). */
  readonly cwd: string;
  /** Absolute repository root whose host files (agents, skills, hooks) apply. */
  readonly projectRoot: string;
  /** Absolute run directory: artifacts go there. */
  readonly runDir: string;
  /** The host session to continue, when there is one. */
  readonly resume?: string;
}

export interface AgentQuestion {
  readonly source: "agent" | "permission";
  readonly prompt: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect: boolean;
}

/** What a person chose: option labels and, optionally, their own words. */
export interface AgentAnswer {
  readonly choices: readonly string[];
  readonly text?: string;
}

export type AgentEvent =
  | { readonly type: "session"; readonly id: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly summary: string }
  | { readonly type: "result"; readonly ok: boolean; readonly text: string };

/** One line of `.metator/runs/<id>/activity.jsonl`: what the drive did, for the live view. */
export const RunActivitySchema = z.strictObject({
  at: z.iso.datetime(),
  type: z.enum(["drive", "stage", "agent", "text", "tool", "question", "answer", "gate", "advance", "error"]),
  stage: z.string().optional(),
  agent: z.string().optional(),
  text: z.string(),
});
export type RunActivity = z.output<typeof RunActivitySchema>;

export const RunActivityDocument = defineDocument("RunActivity", {
  latest: RunActivitySchema,
  hint: "Written by `metator run drive`; one versioned JSON object per line.",
});

export const QuestionOptionSchema = z.strictObject({
  label: z.string().min(1),
  description: z.string().optional(),
});

/** A question to a person (`.metator/runs/<id>/questions/<id>.json`), answered in the same file. */
export const QuestionSchema = z.strictObject({
  id: z.string().regex(/^q[0-9]{3,}$/),
  runId: z.string(),
  stage: z.string(),
  /** gate: a HITL stage; agent: the worker asked; permission: the worker wants a tool. */
  source: z.enum(["gate", "agent", "permission"]),
  agent: z.string().optional(),
  prompt: z.string().min(1),
  options: z.array(QuestionOptionSchema).min(1),
  multiSelect: z.boolean(),
  askedAt: z.iso.datetime(),
  answer: z
    .strictObject({
      choices: z.array(z.string()).min(1),
      text: z.string().optional(),
      by: z.string().min(1),
      at: z.iso.datetime(),
    })
    .optional(),
});
export type Question = z.output<typeof QuestionSchema>;
export type QuestionAnswer = NonNullable<Question["answer"]>;

export const QuestionDocument = defineDocument("Question", {
  latest: QuestionSchema,
  hint: "Answer with `metator run answer <question> --choice <label> --by <name>`.",
});

/** The drive process of a run (`.metator/runs/<id>/driver.json`), so others can stop or find it. */
export const RunDriverDocument = defineDocument("RunDriver", {
  latest: z.strictObject({ pid: z.number().int().positive(), host: z.string(), startedAt: z.iso.datetime() }),
});

/** Who works a stage: agents run in order, skills are offered to them, scripts are commands. */
export interface StageWork {
  readonly agents: readonly string[];
  readonly skills: readonly string[];
  readonly scripts: readonly string[];
  readonly parallel: readonly string[];
}

export function stageWork(stage: StageSpec): StageWork {
  const owners = stage.owner === undefined ? [] : Array.isArray(stage.owner) ? stage.owner : [stage.owner];
  const split = (list: readonly string[]) => ({
    agents: list.filter((o) => !o.startsWith("skill:") && !o.startsWith("script:")),
    skills: list.filter((o) => o.startsWith("skill:")).map((o) => o.slice(6)),
    scripts: list.filter((o) => o.startsWith("script:")).map((o) => o.slice(7)),
  });
  const own = split(owners);
  const side = split(stage.parallel ?? []);
  return {
    agents: own.agents,
    skills: [...own.skills, ...side.skills],
    scripts: [...own.scripts, ...side.scripts],
    parallel: side.agents,
  };
}

export interface StagePromptInput {
  readonly runId: string;
  readonly task: string;
  readonly stage: StageSpec;
  readonly agent: string;
  readonly skills: readonly string[];
  /** Absolute run directory, where artifacts go. */
  readonly runDir: string;
  /** What a person said when the agent asked before. */
  readonly answer?: string;
  /** Why the stage came back (a FAIL from its gate), when it did. */
  readonly retry?: string;
}

/** The message a worker gets: one stage, its artifacts, and how to report back. */
export function stagePrompt(input: StagePromptInput): string {
  const produces = input.stage.produces ?? [];
  const lines = [
    `You are ${input.agent}, working stage "${input.stage.id}" of run ${input.runId}.`,
    `Task: ${input.task}`,
    ...(input.stage.description ? [`Stage goal: ${input.stage.description}`] : []),
    ...(produces.length > 0
      ? [`Write these artifacts into ${input.runDir}: ${produces.join(", ")}.`]
      : [`Artifacts of the run are in ${input.runDir}.`]),
    ...(input.skills.length > 0 ? [`Skills you may use: ${input.skills.join(", ")}.`] : []),
    ...(input.retry ? [`The previous attempt failed its gate: ${input.retry}`] : []),
    ...(input.answer ? [`A person answered your question: ${input.answer}`] : []),
    "Finish with exactly one last line:",
    "STATUS: done",
    "or, when you cannot continue without a decision from a person:",
    "STATUS: blocked: <the question>",
  ];
  return `${lines.join("\n")}\n`;
}

/** The message a critic gets for an LLM gate. */
export function gatePrompt(input: Omit<StagePromptInput, "skills" | "answer">): string {
  const lines = [
    `You are ${input.agent}, the critic of stage "${input.stage.id}" of run ${input.runId}.`,
    `Task: ${input.task}`,
    `Review the artifacts in ${input.runDir}: ${(input.stage.produces ?? []).join(", ") || "(none listed)"}.`,
    "Finish with exactly one last line:",
    "VERDICT: PASS",
    "or",
    "VERDICT: FAIL: <the reason>",
  ];
  return `${lines.join("\n")}\n`;
}

export type WorkerStatus =
  | { readonly kind: "done" }
  | { readonly kind: "blocked"; readonly question: string };

/** The worker's last `STATUS:` line; none at all counts as done when the host said it succeeded. */
export function parseStatus(text: string): WorkerStatus | undefined {
  const line = lastMarked(text, "STATUS:");
  if (line === undefined) return undefined;
  const blocked = /^blocked:\s*(.+)$/i.exec(line);
  if (blocked) return { kind: "blocked", question: (blocked[1] as string).trim() };
  return /^done\b/i.test(line) ? { kind: "done" } : undefined;
}

export type CriticVerdict = { readonly pass: true } | { readonly pass: false; readonly reason: string };

/** The critic's last `VERDICT:` line; anything else is a FAIL, never a silent pass. */
export function parseCriticVerdict(text: string): CriticVerdict {
  const line = lastMarked(text, "VERDICT:");
  if (line !== undefined && /^PASS\b/i.test(line)) return { pass: true };
  const reason = line ? /^FAIL:?\s*(.*)$/i.exec(line)?.[1]?.trim() : undefined;
  return { pass: false, reason: reason || "the critic gave no VERDICT line" };
}

function lastMarked(text: string, marker: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as string;
    if (l.toUpperCase().startsWith(marker)) return l.slice(marker.length).trim();
  }
  return undefined;
}

/** The id of the next question in a run (`q001`, `q002`, …). */
export function nextQuestionId(existing: readonly string[]): string {
  const max = existing.reduce((m, id) => Math.max(m, Number(id.slice(1)) || 0), 0);
  return `q${String(max + 1).padStart(3, "0")}`;
}
