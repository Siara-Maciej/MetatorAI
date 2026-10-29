import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentAnswer, AgentEvent, AgentHost, AgentQuestion, AgentTask } from "@metator/core";

/** The slice of the Agent SDK's `query()` this host uses; injected in tests, imported lazily otherwise. */
export type ClaudeQuery = (params: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

type Permission =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

interface SdkQuestion {
  readonly question: string;
  readonly header?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
}

/** A tool call in the activity log: short. */
const summarize = (input: unknown) => JSON.stringify(input ?? {}).slice(0, 200);

/** What a tool call does, for a person deciding on it: a command whole, other input shortened. */
const described = (input: unknown) => {
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command === "string") return command.length > 4000 ? `${command.slice(0, 4000)}…` : command;
  return JSON.stringify(input ?? {}).slice(0, 400);
};

const WRITES = new Set(["Write", "Edit", "MultiEdit"]);
/** The real path of `path` (links resolved) through its nearest existing ancestor: it may be new. */
const real = (path: string): string => {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(real(parent), basename(abs));
  }
};
/** Inside `dir`, also through a link (a worktree reaches its run directory through one). */
const inside = (dir: string, file: string) => {
  const rel = relative(real(dir), real(resolve(dir, file)));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * The narrow command grants an agent declares (`Bash(metator run:*)` in its `.claude/agents`
 * file): pre-approved, so a person is not asked for every `metator` call the agent is built on.
 * Broad tools (Edit, Write, plain Bash) still ask.
 */
export function declaredCommands(agentFile: string): string[] {
  let text: string;
  try {
    text = readFileSync(agentFile, "utf8");
  } catch {
    return [];
  }
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const tools = /^tools:\s*(.+)$/m.exec(front)?.[1] ?? "";
  return tools
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^Bash\([^()]+:\*\)$/.test(t));
}

/**
 * AgentHost on the Claude Agent SDK (ADR-0051): the canonical agent runs as the main thread
 * (`agent`), with the project's `.claude/` agents, skills and hooks. AskUserQuestion and every
 * permission prompt become questions for a person; the session id is reported so a run resumes.
 */
export class ClaudeAgentHost implements AgentHost {
  readonly id = "claude";

  constructor(private readonly query?: ClaudeQuery) {}

  async *run(task: AgentTask, ask: (q: AgentQuestion) => Promise<AgentAnswer>): AsyncIterable<AgentEvent> {
    const query = this.query ?? (await loadQuery());
    const canUseTool = async (tool: string, input: Record<string, unknown>): Promise<Permission> => {
      if (tool === "AskUserQuestion")
        return { behavior: "allow", updatedInput: await answerQuestions(input, ask) };
      // Writing the run's own artifacts is the stage's job, and so is editing the run's own
      // worktree: it is isolated, and nothing leaves it without a person (push needs an approval).
      // A write anywhere else, the checkout itself included, asks a person.
      const isolated = task.cwd !== task.projectRoot;
      if (
        WRITES.has(tool) &&
        typeof input.file_path === "string" &&
        (inside(task.runDir, input.file_path) || (isolated && inside(task.cwd, input.file_path)))
      )
        return { behavior: "allow", updatedInput: input };
      const answer = await ask({
        source: "permission",
        prompt: `${task.agent} wants to use ${tool}: ${described(input)}`,
        options: [
          { label: "Allow", description: "Run this tool call" },
          { label: "Deny", description: "Refuse it; the agent is told why" },
        ],
        multiSelect: false,
      });
      return answer.choices.includes("Allow")
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: answer.text ?? "a person denied this tool call" };
    };
    const options: Record<string, unknown> = {
      cwd: task.cwd,
      agent: task.agent,
      allowedTools: declaredCommands(join(task.projectRoot, ".claude", "agents", `${task.agent}.md`)),
      settingSources: ["project"],
      permissionMode: "default",
      additionalDirectories: [task.runDir],
      canUseTool,
      ...(task.cwd !== task.projectRoot ? { projectConfigRoot: task.projectRoot } : {}),
      ...(task.resume ? { resume: task.resume } : {}),
    };
    for await (const message of query({ prompt: task.prompt, options })) yield* toEvents(message);
  }
}

/** One SDK message as host-neutral events. */
export function* toEvents(message: Record<string, unknown>): Generator<AgentEvent> {
  if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
    yield { type: "session", id: message.session_id };
  } else if (message.type === "assistant") {
    const content = ((message.message as { content?: unknown[] } | undefined)?.content ?? []) as {
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
    }[];
    for (const block of content) {
      if (block.type === "text" && block.text) yield { type: "text", text: block.text };
      else if (block.type === "tool_use")
        yield { type: "tool", name: block.name ?? "tool", summary: summarize(block.input) };
    }
  } else if (message.type === "result") {
    const ok = message.subtype === "success" && message.is_error !== true;
    const text =
      typeof message.result === "string"
        ? message.result
        : `${String(message.subtype)}${Array.isArray(message.errors) ? `: ${message.errors.join("; ")}` : ""}`;
    yield { type: "result", ok, text };
  }
}

/** AskUserQuestion: each question goes to a person; the answers go back keyed by question text. */
async function answerQuestions(
  input: Record<string, unknown>,
  ask: (q: AgentQuestion) => Promise<AgentAnswer>,
): Promise<Record<string, unknown>> {
  const questions = (input.questions ?? []) as SdkQuestion[];
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const a = await ask({
      source: "agent",
      prompt: q.header ? `${q.header}: ${q.question}` : q.question,
      options: (q.options ?? []).map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      })),
      multiSelect: q.multiSelect === true,
    });
    answers[q.question] = a.text ?? a.choices.join(", ");
  }
  return { ...input, questions, answers };
}

/** The SDK is large (it ships Claude Code): load it only when a run uses this host. */
async function loadQuery(): Promise<ClaudeQuery> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as { query: ClaudeQuery };
  return sdk.query;
}
