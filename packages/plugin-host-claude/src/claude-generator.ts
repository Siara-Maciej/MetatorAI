import {
  type Agent,
  type BasicCapability,
  err,
  type GeneratedFile,
  generatedMarker,
  HOOK_BINDINGS,
  type HostAgentContext,
  type HostGenerator,
  isGuardCommand,
  MetatorError,
  type ModelTier,
  metatorGroups,
  ok,
  type Result,
  withMetatorCommand,
} from "@metator/core";
import { stringify } from "yaml";

/** The one place that knows Claude Code's tool names. Changes go here only. */
export const CLAUDE_TOOLS: Readonly<Record<BasicCapability, readonly string[]>> = {
  read: ["Read", "Glob"],
  search: ["Grep", "Glob"],
  edit: ["Edit", "Write"],
  execute: ["Bash"],
  agent: ["Task"],
  todo: ["TodoWrite"],
  web: ["WebFetch", "WebSearch"],
};

/** Claude Code model aliases per tier, unless the config names a model. */
export const CLAUDE_MODELS: Readonly<Record<ModelTier, string>> = {
  reasoning: "opus",
  standard: "sonnet",
  fast: "haiku",
};

/** `.claude/agents/<id>.md` (ADR-0030). */
export class ClaudeGenerator implements HostGenerator {
  readonly host = "claude";
  readonly owns = [".claude/agents/*.md"];
  readonly hooksFile = ".claude/settings.json";

  /** `.claude/settings.json#hooks`; the user's other settings and their own hooks stay. */
  hooks(metatorCommand: string, existing: string | undefined): Result<GeneratedFile, MetatorError> {
    let settings: Record<string, unknown>;
    try {
      settings = existing === undefined ? {} : (JSON.parse(existing) as Record<string, unknown>);
    } catch (e) {
      return err(new MetatorError("INVALID_CONFIG", `${this.hooksFile}: ${(e as Error).message}`));
    }
    const hooks = { ...((settings.hooks as Record<string, Group[]> | undefined) ?? {}) };
    for (const b of HOOK_BINDINGS) {
      const theirs = (hooks[b.event] ?? [])
        .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isGuardCommand(h.command)) }))
        .filter((g) => g.hooks.length > 0);
      const ours: Group = {
        ...(b.matcher ? { matcher: b.matcher } : {}),
        hooks: [{ type: "command", command: `${metatorCommand} guard ${b.guard}`, timeout: b.timeout }],
      };
      hooks[b.event] = [...theirs, ours];
    }
    return ok({ path: this.hooksFile, content: `${JSON.stringify({ ...settings, hooks }, null, 2)}\n` });
  }

  agent(agent: Agent, body: string, context: HostAgentContext): GeneratedFile {
    const tools = new Set<string>();
    for (const c of agent.capabilities) {
      if (!c.startsWith("metator:")) for (const t of CLAUDE_TOOLS[c as BasicCapability]) tools.add(t);
    }
    // Without general Bash, MetatorAI command groups are allowed one by one.
    if (!tools.has("Bash"))
      for (const g of metatorGroups(agent)) tools.add(`Bash(${context.metatorCommand} ${g}:*)`);
    const front = {
      name: agent.id,
      description: agent.description,
      tools: [...tools].join(", "),
      model: context.model ?? CLAUDE_MODELS[agent.tier],
    };
    return {
      path: `.claude/agents/${agent.id}.md`,
      content: `---\n${stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n${generatedMarker(context.source)}\n${prose(body, context)}`,
    };
  }
}

function prose(body: string, context: HostAgentContext): string {
  const text = withMetatorCommand(body, context.metatorCommand);
  return text.startsWith("\n") ? text : `\n${text}`;
}

interface Group {
  readonly matcher?: string;
  readonly hooks: readonly { readonly type: string; readonly command?: string; readonly timeout?: number }[];
}
