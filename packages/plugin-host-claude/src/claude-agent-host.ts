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

const summarize = (input: unknown) => JSON.stringify(input ?? {}).slice(0, 200);

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
      const answer = await ask({
        source: "permission",
        prompt: `${task.agent} wants to use ${tool}: ${summarize(input)}`,
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
