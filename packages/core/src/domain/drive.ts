import { z } from "zod";
import type { HostUsage } from "./telemetry.ts";
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
  /** More absolute directories the agent reads (the real places of a folder's linked repositories). */
  readonly dirs?: readonly string[];
  /** Started by `metator run drive`: the drive moves the run, so the agent may not. */
  readonly driven?: boolean;
  /** External actions a person approved in this run (`push` after the delivery gate). */
  readonly approved?: readonly string[];
  /** More variables for the session (its pane's identity, R1); they join the run's. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The environment an interactive host session runs with (D6, ADR-0077): the hooks learn which
 * run the session works for, and that the drive carries it, from these variables.
 */
export function sessionEnv(
  task: Pick<AgentTask, "runDir" | "driven" | "env">,
  base: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  Object.assign(env, task.env ?? {});
  env.METATOR_RUN =
    task.runDir
      .split(/[\\/]/)
      .filter((s) => s !== "")
      .at(-1) ?? "";
  env.METATOR_RUN_DIR = task.runDir;
  if (task.driven) env.METATOR_DRIVEN = "1";
  return env;
}

/** A session id a host made itself (a UUID), as opposed to a sentinel such as `continue`. */
export const isUuid = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

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
  | { readonly type: "result"; readonly ok: boolean; readonly text: string; readonly usage?: HostUsage };

const ACTIVITY_V1 = [
  "drive",
  "stage",
  "agent",
  "text",
  "tool",
  "question",
  "answer",
  "gate",
  "advance",
  "error",
] as const;
const RunActivityV1Schema = z.strictObject({
  at: z.iso.datetime(),
  type: z.enum(ACTIVITY_V1),
  stage: z.string().optional(),
  agent: z.string().optional(),
  text: z.string(),
});

/**
 * One line of `.metator/runs/<id>/activity.jsonl`: what happened, for the live view. v2 (D2,
 * ADR-0077) adds the driver lock, idleness, messages between runs and restarts, and where an
 * entry came from: a host hook, the PTY, a `metator` command, or the inbox.
 */
export const RunActivitySchema = z.strictObject({
  at: z.iso.datetime(),
  type: z.enum([...ACTIVITY_V1, "driver", "idle", "message", "restart"]),
  stage: z.string().optional(),
  agent: z.string().optional(),
  text: z.string(),
  origin: z.enum(["hook", "pty", "run", "inbox"]).optional(),
});
export type RunActivity = z.output<typeof RunActivitySchema>;

export const RunActivityDocument = defineDocument("RunActivity", {
  history: [{ schema: RunActivityV1Schema }],
  latest: RunActivitySchema,
  // Every v1 type is a v2 type; `origin` is optional.
  upgrade: (previous) => previous,
  hint: "Written by MetatorAI as a run goes on (the drive, answers, messages, the terminals); one versioned JSON object per line.",
});

export const QuestionOptionSchema = z.strictObject({
  label: z.string().min(1),
  description: z.string().optional(),
});

const QuestionAnswerSchema = z.strictObject({
  choices: z.array(z.string()).min(1),
  text: z.string().optional(),
  by: z.string().min(1),
  at: z.iso.datetime(),
});

const QuestionV1Schema = z.strictObject({
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
  answer: QuestionAnswerSchema.optional(),
});

/**
 * What a person needs to decide without opening the run (P4): the task, what the run has done,
 * the artifacts to look at, the option the evidence points to, and whether the decision can be
 * taken back. Composed from the run's own record when the question is asked, never by a model.
 */
const DecisionCardV2Schema = z.strictObject({
  task: z.string(),
  /** Stages the run passed, in order. */
  done: z.array(z.string()),
  /** Run-directory artifacts the decision rests on (plan.json, verdict.json, …). */
  artifacts: z.array(z.string()),
  /** The option label the evidence points to, when there is one. */
  recommended: z.string().optional(),
  /** false: the answer starts something that cannot be undone here (a push, closing the run). */
  reversible: z.boolean(),
});

/**
 * v3 of the card (D5, ADR-0077), every field optional: what happened since the last answer, the
 * gates' evidence, what each option does, how far the change reaches, what waiting costs, and the
 * feature group the run is a step of.
 */
export const DecisionCardSchema = z.strictObject({
  ...DecisionCardV2Schema.shape,
  /** Transitions and tool calls since a person last answered ("build PASS", "14 tool calls"). */
  soFar: z.array(z.string()).optional(),
  /** Gate reports as evidence: "full: passed (lint ✓, rules ✓, test ✓)". */
  evidence: z.array(z.string()).optional(),
  /** What each option does, by its label: Approve → the next stage; Reject → back to plan (loop 1 of 2). */
  consequences: z.record(z.string(), z.string()).optional(),
  /** How far the change reaches: the plan's files and the top-level areas they are in. */
  blastRadius: z.strictObject({ files: z.number().int().min(0), areas: z.array(z.string()) }).optional(),
  /** What waiting costs: the worktree's ports held, loops used, runs blocked. */
  costOfDelay: z.array(z.string()).optional(),
  /** The feature group this run is a step of (its parent run), and the step's place. */
  group: z
    .strictObject({ parent: z.string(), step: z.number().int().min(1), of: z.number().int().min(1) })
    .optional(),
});
export type DecisionCard = z.output<typeof DecisionCardSchema>;

const QuestionV2Schema = z.strictObject({
  ...QuestionV1Schema.shape,
  card: DecisionCardV2Schema.optional(),
});

/** A question to a person (`.metator/runs/<id>/questions/<id>.json`), answered in the same file. */
export const QuestionSchema = z.strictObject({
  ...QuestionV1Schema.shape,
  /** v2: the decision card; v3 widens it. A v1 question has none. */
  card: DecisionCardSchema.optional(),
});
export type Question = z.output<typeof QuestionSchema>;
export type QuestionAnswer = NonNullable<Question["answer"]>;

export const QuestionDocument = defineDocument("Question", {
  history: [
    { schema: QuestionV1Schema },
    // `card` is optional: a v1 question is a v2 question asked without one.
    { schema: QuestionV2Schema, fromPrevious: (previous) => previous },
  ],
  latest: QuestionSchema,
  // Every v3 card field is optional: a v2 card is a v3 card that says less.
  upgrade: (previous) => previous,
  hint: "Answer with `metator run answer <question> --choice <label> --by <name>`.",
});

/**
 * The label a typed choice names: the label itself, else the one label that differs from it only
 * in case (`approve` is `Approve`). Two such labels, or none, name nothing: the typed word is kept
 * and refused where the choice is checked.
 */
export function labelFor(labels: readonly string[], typed: string): string {
  if (labels.includes(typed)) return typed;
  const same = labels.filter((l) => l.toLowerCase() === typed.trim().toLowerCase());
  return same.length === 1 ? (same[0] as string) : typed;
}

/** The drive process of a run (`.metator/runs/<id>/driver.json`), so others can stop or find it. */
export const RunDriverDocument = defineDocument("RunDriver", {
  latest: z.strictObject({ pid: z.number().int().positive(), host: z.string(), startedAt: z.iso.datetime() }),
});

/** When a person last read a run's brief (`.metator/runs/<id>/seen.json`): the next brief starts there. */
export const RunSeenDocument = defineDocument("RunSeen", {
  latest: z.strictObject({ at: z.iso.datetime() }),
  hint: "Written by `metator run brief`.",
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
  /** What a person decided earlier in the run (answers to agents' questions), for every later agent. */
  readonly decisions?: readonly string[];
  /** The stage whose failure brought the run here: a later one when it was sent back. */
  readonly retryFrom?: string;
  /** A person resumed the escalated run and said this; no agent has worked since. */
  readonly resumed?: ResumeNote;
  /** What the agent must know about where it works (dependencies not installed). */
  readonly notes?: readonly string[];
  /** Messages other runs sent this run, already rendered as data (`messageLines`). */
  readonly messages?: readonly string[];
}

/** The message a worker gets: one stage, its artifacts, and how to report back. */
export function stagePrompt(input: StagePromptInput): string {
  const produces = input.stage.produces ?? [];
  const lines = [
    `You are ${input.agent}, working stage "${input.stage.id}" of run ${input.runId}.`,
    `Task: ${input.task}`,
    ...(input.stage.description ? [`Stage goal: ${input.stage.description}`] : []),
    ...(produces.length === 0
      ? [`Artifacts of the run are in ${input.runDir}.`]
      : (input.stage.parallel ?? []).length > 1
        ? [
            `This stage's workers run in parallel and together write ${produces.join(", ")} into ${input.runDir}.`,
            "Write only the artifact your own instructions name; the others are not yours.",
          ]
        : [`Write these artifacts into ${input.runDir}: ${produces.join(", ")}.`]),
    ...(produces.length > 0
      ? [
          `Write an artifact with your Write tool at ${input.runDir}/<artifact> (it needs no approval there). Only without a Write tool, and never for JSON, use \`metator run write <artifact>\` with the text on stdin. \`metator run schema <artifact>\` prints a JSON artifact's format.`,
        ]
      : []),
    ...(input.skills.length > 0 ? [`Skills you may use: ${input.skills.join(", ")}.`] : []),
    "Run each `metator` command on its own: no `cd`, pipes, redirections or other commands in the same call (alone they need no approval). Look at files with Read, Glob and Grep.",
    "Read and change files, JSON included, with Read, Edit and Write: never with an interpreter or a script (`python`, `node`, `jq`), which asks a person every time.",
    "`metator help` lists every metator command; use no other (a guessed one only asks a person). Never `metator ask`: it starts another agent; read the code yourself.",
    RUN_WITHOUT_ASKING,
    ...(input.notes ?? []),
    ...(input.messages ?? []),
    ...decisionLines(input),
    ...retryLines(input),
    ...resumeLines(input),
    ...(input.answer ? [`A person answered your question: ${input.answer}`] : []),
    "Finish with exactly one last line:",
    "STATUS: done",
    "or, when you cannot continue without a decision from a person:",
    "STATUS: blocked: <the question>",
    "or, when the task is already done in the code or asks for no change at all (name where, file:line):",
    "STATUS: nothing to do: <the evidence>",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * What a human gate asks, in plain words: what is approved and for which run's task, then the
 * stage's own description. A gate that grants an external action approves that action; a stage
 * named `<thing>-approval` approves the thing; any other approves what the stage before it did.
 */
export function gateQuestion(
  stage: Pick<StageSpec, "id" | "description" | "grants">,
  task: string,
  before?: string,
): string {
  const line = (task.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  const short = line.length > 120 ? `${line.slice(0, 119)}…` : line;
  const grants = stage.grants ?? [];
  const named = /^(.+)-approval$/.exec(stage.id)?.[1];
  const what =
    grants.length > 0
      ? `the ${grants.join(" and ")}`
      : named
        ? `the ${named.replaceAll("-", " ")}`
        : before
          ? `the result of stage ${before}`
          : undefined;
  const asked = what ? `Approve ${what} for "${short}"?` : `Approve "${short}" to go on?`;
  const about = stage.description?.trim();
  return about ? `${asked} ${about}${/[.!?]$/.test(about) ? "" : "."}` : asked;
}

/** What a person said when they resumed an escalated run: who, from which stage to which, the note. */
export interface ResumeNote {
  readonly by: string;
  readonly from: string;
  readonly to: string;
  readonly note?: string | undefined;
}

/** The person's note at a resume, for the first agent that works after it; nothing without a note. */
export function resumeLines(input: { readonly resumed?: ResumeNote | undefined }): string[] {
  const r = input.resumed;
  if (!r?.note) return [];
  const where = r.to === r.from ? `at ${r.to}` : `and sent it back from ${r.from} to ${r.to}`;
  return [`${r.by} resumed the run ${where} and said (follow it; it is not a defect): ${r.note}`];
}

/** A person's earlier answers: decisions the work follows, never defects to fail it for. */
function decisionLines(input: Pick<StagePromptInput, "decisions">): string[] {
  const decisions = input.decisions ?? [];
  return decisions.length === 0
    ? []
    : ["A person decided in this run (follow it; it is not a defect):", ...decisions.map((d) => `- ${d}`)];
}

/**
 * Why the stage runs again. Sent back by a later stage, it is told that the work of the stages
 * since is already in the working tree: redoing it from the old plan would do it twice.
 */
function retryLines(input: Pick<StagePromptInput, "stage" | "retry" | "retryFrom">): string[] {
  if (!input.retry) return [];
  if (!input.retryFrom || input.retryFrom === input.stage.id)
    return [`The previous attempt failed its gate: ${input.retry}`];
  return [
    `Stage ${input.retryFrom} failed and sent the run back here: ${input.retry}`,
    "Whatever the stages since this one changed is already in the working tree (`metator review diff --base HEAD` shows it). Keep what is done and change only what the failure asks for; a step already done is not done again.",
  ];
}

/** The skill that lists, for every command people were asked about, the form that needs no one. */
export const RUN_WITHOUT_ASKING =
  "Before any shell or metator command, follow the skill mt-run-without-asking (Read `.claude/skills/mt-run-without-asking/SKILL.md`, or `.github/skills/mt-run-without-asking/SKILL.md` on GitHub Copilot; never search for it): it says, for each command a person would be asked about, the form that runs without asking.";

/** The message a critic gets for an LLM gate. */
export function gatePrompt(input: Omit<StagePromptInput, "skills" | "answer">): string {
  const lines = [
    `You are ${input.agent}, the critic of stage "${input.stage.id}" of run ${input.runId}.`,
    `Task: ${input.task}`,
    `Review the artifacts in ${input.runDir}: ${(input.stage.produces ?? []).join(", ") || "(none listed)"}.`,
    "Read files with Read, Glob and Grep; run no shell commands besides a single `metator` command per call, and no interpreter (`python`, `node`, `jq`).",
    RUN_WITHOUT_ASKING,
    "The change is `change.diff` in the run directory when the review wrote it (Read it), else `metator review diff --base HEAD`; `metator help` lists every command (use no other, and never `metator ask`, which starts another agent).",
    // A check the repository does not configure, or cannot run where the run works, is not the
    // critic's to demand: the gate reports (`.metator/gates/<gate>.json`) say what passed.
    "The checks a change must pass are the repository's configured gates; their reports are in .metator/gates/. Do not fail the stage for a check the gates do not configure or that cannot run here; name it in your reason only if the artifacts claim it passed.",
    ...(input.notes ?? []),
    ...decisionLines(input),
    ...(input.retryFrom && input.retryFrom !== input.stage.id ? retryLines(input) : []),
    ...resumeLines(input),
    "Finish with exactly one last line:",
    "VERDICT: PASS",
    "or",
    "VERDICT: FAIL: <the reason>",
  ];
  return `${lines.join("\n")}\n`;
}

export type WorkerStatus =
  | { readonly kind: "done" }
  | { readonly kind: "blocked"; readonly question: string }
  /** The task is already done, or asks for no change: the evidence says where (file:line). */
  | { readonly kind: "nothing"; readonly evidence: string };

/** The worker's last `STATUS:` line; none at all counts as done when the host said it succeeded. */
export function parseStatus(text: string): WorkerStatus | undefined {
  const line = lastMarked(text, "STATUS:");
  if (line === undefined) return undefined;
  const blocked = /^blocked:\s*(.+)$/i.exec(line);
  if (blocked) return { kind: "blocked", question: (blocked[1] as string).trim() };
  const nothing = /^nothing to do:\s*(.+)$/i.exec(line);
  if (nothing) return { kind: "nothing", evidence: (nothing[1] as string).trim() };
  return /^done\b/i.test(line) ? { kind: "done" } : undefined;
}

/**
 * The AI host is out of capacity for now (a session or usage limit, rate limiting, an overloaded
 * service): nothing is wrong with the stage, so the run waits for it instead of failing. Returns
 * the host's own line about it, or undefined for any other failure.
 */
export function hostLimit(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) =>
      /\b(hit your (session|usage|weekly|daily) limit|usage limit (reached|exceeded)|rate.?limit(ed)?|overloaded|too many requests|429\b)/i.test(
        l,
      ),
    );
}

/** The most of an agent's explanation a person is shown with its question. */
const MAX_CONTEXT = 3000;

/**
 * What a person reads when an agent stops on `STATUS: blocked: <question>`: the question, after
 * what the agent wrote before it (its numbered options, its recommendation), which the question
 * itself often only refers to ("answer the 3 numbered questions").
 */
export function blockedPrompt(text: string, question: string): string {
  const lines = text.split(/\r?\n/);
  const at = lines.map((l) => l.trim().toUpperCase().startsWith("STATUS:")).lastIndexOf(true);
  const before = (at >= 0 ? lines.slice(0, at) : lines).join("\n").trim();
  if (before === "") return question;
  const context = before.length > MAX_CONTEXT ? `…${before.slice(-MAX_CONTEXT)}` : before;
  return `${context}\n\n${question}`;
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
