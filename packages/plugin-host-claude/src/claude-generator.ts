import {
  type Agent,
  type BasicCapability,
  claudeDenyRules,
  DEFAULT_GUARD_COMMANDS,
  err,
  type GeneratedFile,
  type GuardCommands,
  HOOK_BINDINGS,
  type HostAgentContext,
  type HostGenerator,
  hostAgentFile,
  isGuardCommand,
  MetatorError,
  type ModelTier,
  metatorGroups,
  ok,
  type Result,
  SECRET_GLOBS,
} from "@metator/core";

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

/** Where Claude Code reads an agent from, repo-relative. The one place that knows. */
export const claudeAgentFile = (id: string): string => `.claude/agents/${id}.md`;

/** `.claude/agents/<id>.md` (ADR-0030). */
export class ClaudeGenerator implements HostGenerator {
  readonly host = "claude";
  readonly owns = [".claude/agents/*.md"];
  readonly hooksFile = ".claude/settings.json";

  /**
   * `.claude/settings.json#hooks` and `permissions.deny`; the user's other settings, their own
   * hooks and rules stay. No `sandbox` block is written (ADR-0104): MetatorAI starts the whole
   * session inside its own sandbox, and a second one nested in it cannot start.
   */
  hooks(
    metatorCommand: string,
    existing: string | undefined,
    guard: GuardCommands = DEFAULT_GUARD_COMMANDS,
  ): Result<GeneratedFile, MetatorError> {
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
    // What cannot be taken back is a deny rule as well (ADR-0100): Claude Code reads those before
    // any hook, prompt or classifier. The person's rules stay first; ours are added once.
    const permissions = { ...((settings.permissions as Record<string, unknown> | undefined) ?? {}) };
    const theirs = Array.isArray(permissions.deny) ? (permissions.deny as unknown[]) : [];
    const deny = [...theirs, ...denyRules(guard).filter((r) => !theirs.includes(r))];
    return ok({
      path: this.hooksFile,
      content: `${JSON.stringify({ ...settings, permissions: { ...permissions, deny }, hooks }, null, 2)}\n`,
    });
  }

  agent(agent: Agent, body: string, context: HostAgentContext): GeneratedFile {
    const tools = new Set<string>();
    for (const c of agent.capabilities) {
      if (c.startsWith("metator:")) continue;
      // A coordinator starts only the workers it delegates to: never a general-purpose agent
      // that has every tool its own definition withholds.
      if (c === "agent" && agent.delegates.length > 0) tools.add(`Agent(${agent.delegates.join(", ")})`);
      else for (const t of CLAUDE_TOOLS[c as BasicCapability]) tools.add(t);
    }
    // MetatorAI command groups by name: without general Bash they are all the shell an agent
    // has; with it, they are the commands that run without asking a person (`allowedTools`).
    for (const g of metatorGroups(agent)) tools.add(`Bash(${context.metatorCommand} ${g}:*)`);
    const front = {
      name: agent.id,
      description: agent.description,
      tools: [...tools].join(", "),
      model: context.model ?? CLAUDE_MODELS[agent.tier],
    };
    return hostAgentFile(claudeAgentFile(agent.id), front, body, context);
  }
}

/**
 * Claude Code deny rules (ADR-0100): the secret files, and the config's `guard.commands.never`,
 * the same list Copilot CLI is given as `--deny-tool` (a merge asks, ADR-0094, so it is none of
 * them). A path without a slash matches at any depth; a `!` rule carves its files out of the rules
 * before it, so the examples follow the patterns they belong to.
 */
function denyRules(guard: GuardCommands): string[] {
  const name = (glob: string) => glob.replace(/^(!?)\*\*\//, "$1");
  const secrets = SECRET_GLOBS.filter((g) => !g.startsWith("!"));
  const examples = SECRET_GLOBS.filter((g) => g.startsWith("!"));
  return [
    ...[...secrets, ...examples].map((g) => `Read(${name(g)})`),
    ...claudeDenyRules(guard, { headless: false }),
  ];
}

interface Group {
  readonly matcher?: string;
  readonly hooks: readonly { readonly type: string; readonly command?: string; readonly timeout?: number }[];
}
