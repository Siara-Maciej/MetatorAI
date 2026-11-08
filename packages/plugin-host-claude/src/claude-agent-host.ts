import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type AgentAnswer,
  type AgentEvent,
  type AgentHost,
  type AgentQuestion,
  type AgentTask,
  CHAT_APPROVAL_NEEDS_DRIVER,
  chatApproval,
  commandsOf,
  DRIVEN_RUN_CONTROL,
  declaredAfterCd,
  declaredWithDocument,
  deliveryCommand,
  HERDR_REFUSALS,
  type HostUsage,
  herdrRefusal,
  permissionResponse,
  RunRecordDocument,
  readOnlyCommand,
  removeInside,
  runArtifactWrite,
  runControlCommand,
  secretPath,
  singleDeclaredCommand,
} from "@metator/core";

/** The slice of the Agent SDK's `query()` this host uses; injected in tests, imported lazily otherwise. */
export type ClaudeQuery = (params: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

export const LOCAL_METATOR =
  "There is no ./metator program here: metator is on PATH. Run `metator <command>` on its own, without ./ and without a `||` fallback.";

/** The command runs `./metator`, and no directory it could mean holds a metator program. */
export function noLocalMetator(command: string, dirs: readonly string[]): boolean {
  if (!/(^|[\s;&|(])\.\/metator(\s|$)/.test(command)) return false;
  return !dirs.some((d) => {
    try {
      return statSync(join(d, "metator")).isFile();
    } catch {
      return false;
    }
  });
}

/** Why a command outside an agent's definition is refused without asking anyone. */
export const OUTSIDE_DEFINITION = (agent: string, declared: readonly string[]) =>
  `${agent} runs only the commands its definition declares (${declared.join(", ") || "none"}) and commands that only read inside the working directories. Use those, Read, Grep and Glob; to run code, delegate to an agent that runs it (mt-verifier in a review). This was refused without asking a person.`;

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

/** Who drives the run whose directory this is, from its state.json; the agent when unreadable. */
export function driverOf(runDir: string): "agent" | "human" {
  try {
    const raw = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const record = RunRecordDocument.parse(raw, "state.json");
    return record.isOk() && record.value.driver?.by === "human" ? "human" : "agent";
  } catch {
    return "agent";
  }
}

const WRITES = new Set(["Write", "Edit", "MultiEdit"]);
const READS = new Set(["Read", "Grep", "Glob"]);
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

/** The tools of a front matter line, split at the commas between tools, not inside `Agent(a, b)`. */
function toolList(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of line) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * The agent of a generated `.claude/agents` file as an SDK definition. The session gets it
 * directly, so it applies wherever the session works: in a folder of repositories the working
 * directory has no `.claude/` of its own.
 */
export function agentDefinition(
  agentFile: string,
): { description: string; prompt: string; tools?: string[]; model?: string } | undefined {
  let text: string;
  try {
    text = readFileSync(agentFile, "utf8");
  } catch {
    return undefined;
  }
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(m[1] as string)?.[1]?.trim();
  const tools = field("tools");
  const model = field("model");
  return {
    description: field("description") ?? "",
    prompt: (m[2] as string).trim(),
    ...(tools ? { tools: toolList(tools) } : {}),
    ...(model ? { model } : {}),
  };
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
    const isolated = task.cwd !== task.projectRoot;
    const dirs = [task.cwd, task.projectRoot, task.runDir, ...(task.dirs ?? [])];
    // What runs without a person: a search through the shell that only reads (a host without
    // Grep and Glob searches this way), reading or searching where the session may read, writing
    // the run's own artifacts (the stage's job) and editing the run's own worktree (isolated;
    // nothing leaves it without a person, push needs an approval). A write anywhere else, the
    // checkout itself included, asks a person. A file that may hold secrets is denied before this.
    // The commands the agent's definition declares (`Bash(metator findings:*)` → `metator findings`).
    // The run directory as given, where it really is, and as the worktree reaches it (its
    // `.metator/runs` is a link to the checkout's).
    const runs = /\/(\.metator\/runs\/.+)$/.exec(task.runDir)?.[1];
    const runDirs = [task.runDir, real(task.runDir), ...(runs ? [join(task.cwd, runs)] : [])];
    const declared = declaredCommands(join(task.projectRoot, ".claude", "agents", `${task.agent}.md`)).map(
      (t) => t.slice("Bash(".length, -":*)".length),
    );
    const needsNoPerson = (
      tool: string,
      input: Record<string, unknown>,
      own: readonly string[] = declared,
    ): boolean => {
      if (tool === "Bash")
        return (
          typeof input.command === "string" &&
          (readOnlyCommand(input.command, dirs) ||
            // The agent's own declared command, alone; its quoted text may hold `&&` or `|`.
            singleDeclaredCommand(input.command, own) ||
            // After the push is approved: committing and pushing the run's branch in its worktree.
            (isolated &&
              (task.approved ?? []).includes("push") &&
              deliveryCommand(input.command, [task.cwd])) ||
            declaredAfterCd(input.command, own, dirs) ||
            declaredWithDocument(input.command, own) ||
            runArtifactWrite(input.command, runDirs, task.cwd) ||
            // Removing a file where Edit and Write need no person: the run directory, an isolated worktree.
            removeInside(input.command, isolated ? [...runDirs, task.cwd] : runDirs, task.cwd))
        );
      const file = input.file_path ?? input.path ?? task.cwd;
      if (typeof file !== "string") return false;
      if (READS.has(tool))
        return dirs.some((dir) => dir === resolve(task.cwd, file) || inside(dir, resolve(task.cwd, file)));
      return WRITES.has(tool) && (inside(task.runDir, file) || (isolated && inside(task.cwd, file)));
    };
    const canUseTool = async (tool: string, input: Record<string, unknown>): Promise<Permission> => {
      if (tool === "AskUserQuestion")
        return { behavior: "allow", updatedInput: await answerQuestions(input, ask) };
      if (needsNoPerson(tool, input)) return { behavior: "allow", updatedInput: input };
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
    const agentFile = join(task.projectRoot, ".claude", "agents", `${task.agent}.md`);
    const definition = agentDefinition(agentFile);
    // Secrets stay unread in-process too: the project's own deny rules and hooks may not apply
    // where the session works (a folder of repositories has no settings of its own).
    const preToolUse = async (input: unknown) => {
      const call = input as { tool_name?: unknown; tool_input?: unknown; agent_type?: unknown };
      const hook = {
        tool: typeof call.tool_name === "string" ? call.tool_name : "",
        input: (call.tool_input ?? {}) as Record<string, unknown>,
        stopActive: false,
      };
      const file = secretPath(hook, task.cwd);
      if (file)
        return permissionResponse({
          decision: "deny",
          reason: `${file} may hold secrets; agents do not read it.`,
        });
      // The drive moves a run it carries: an agent that advances it makes the drive's own event
      // land on the next stage, which is then skipped.
      const control = task.driven ? runControlCommand(hook) : undefined;
      if (control) {
        // A person's yes in the chat, carried by the agent: only while that person is attached
        // (state.json, read now: the lock changes while the session runs).
        if (!chatApproval(hook))
          return permissionResponse({ decision: "deny", reason: DRIVEN_RUN_CONTROL(control) });
        if (driverOf(task.runDir) !== "human")
          return permissionResponse({ decision: "deny", reason: CHAT_APPROVAL_NEEDS_DRIVER });
      }
      // An agent whose definition grants no plain Bash (a coordinator, a lens, a planner) runs only
      // the commands it declares and the ones that need no person: anything else is refused with
      // that reason, never put to a person. The hook names the agent, a subagent's too.
      const agent = typeof call.agent_type === "string" ? call.agent_type : task.agent;
      const command = hook.input.command;
      // `./metator` where no such program is (the repository's metator/ is a folder of agents and
      // skills): refused at once with the right form, not put to a person.
      if (
        hook.tool === "Bash" &&
        typeof command === "string" &&
        noLocalMetator(command, [task.cwd, task.projectRoot])
      )
        return permissionResponse({ decision: "deny", reason: LOCAL_METATOR });
      // herdr (ADR-0079): no typing into another pane, no agents outside a run, no socket.
      const herdr = typeof command === "string" ? herdrRefusal(commandsOf(command), command) : undefined;
      if (hook.tool === "Bash" && herdr)
        return permissionResponse({ decision: "deny", reason: `herdr: ${HERDR_REFUSALS[herdr]}` });
      if (hook.tool === "Bash" && typeof command === "string") {
        const file = join(task.projectRoot, ".claude", "agents", `${agent}.md`);
        const tools = agentDefinition(file)?.tools;
        const own = declaredCommands(file).map((t) => t.slice("Bash(".length, -":*)".length));
        if (
          tools &&
          !tools.includes("Bash") &&
          !singleDeclaredCommand(command, own) &&
          !needsNoPerson("Bash", hook.input, own)
        )
          return permissionResponse({ decision: "deny", reason: OUTSIDE_DEFINITION(agent, own) });
      }
      return {};
    };
    const options: Record<string, unknown> = {
      cwd: task.cwd,
      agent: task.agent,
      ...(definition ? { agents: { [task.agent]: definition } } : {}),
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      allowedTools: declaredCommands(agentFile),
      settingSources: ["project"],
      permissionMode: "default",
      // The run directory as given and where it really is: in a worktree it is a link into the
      // checkout, and the host checks the resolved path.
      additionalDirectories: [...new Set([task.runDir, real(task.runDir), ...(task.dirs ?? [])])],
      canUseTool,
      ...(task.cwd !== task.projectRoot ? { projectConfigRoot: task.projectRoot } : {}),
      env: {
        ...process.env,
        // Workers run in the foreground: one started in the background outlives the turn that
        // started it, and its permission prompts then fail ("Stream closed") or are refused.
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        // The project's hooks (`metator guard *`) see that the drive carries this session.
        ...(task.driven ? { METATOR_DRIVEN: "1" } : {}),
      },
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
    const usage = hostUsage(message);
    yield { type: "result", ok, text, ...(usage ? { usage } : {}) };
  }
}

/** Tokens and cost as the SDK's result message reports them; undefined when it reports none. */
export function hostUsage(message: Record<string, unknown>): HostUsage | undefined {
  const u = (message.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  const input = n(u.input_tokens);
  const output = n(u.output_tokens);
  const cached = n(u.cache_read_input_tokens);
  const created = n(u.cache_creation_input_tokens);
  const cost =
    typeof message.total_cost_usd === "number" && message.total_cost_usd >= 0
      ? message.total_cost_usd
      : undefined;
  const out: HostUsage = {
    ...(input !== undefined || created !== undefined ? { inputTokens: (input ?? 0) + (created ?? 0) } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
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
