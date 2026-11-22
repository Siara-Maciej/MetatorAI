import {
  type Agent,
  type BasicCapability,
  DENIED_COMMANDS,
  err,
  type GeneratedFile,
  HOOK_BINDINGS,
  type HostAgentContext,
  type HostGenerator,
  hostAgentFile,
  isGuardCommand,
  MERGE_MCP_TOOLS,
  MetatorError,
  type ModelTier,
  metatorGroups,
  ok,
  type Result,
  type SandboxPolicy,
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

  /** `.claude/settings.json#hooks`; the user's other settings and their own hooks stay. */
  hooks(
    metatorCommand: string,
    existing: string | undefined,
    sandbox?: SandboxPolicy,
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
    const deny = [...theirs, ...denyRules().filter((r) => !theirs.includes(r))];
    const held = sandbox ? { sandbox: sandboxSettings(settings.sandbox, sandbox) } : {};
    return ok({
      path: this.hooksFile,
      content: `${JSON.stringify({ ...settings, permissions: { ...permissions, deny }, ...held, hooks }, null, 2)}\n`,
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
 * Claude Code's `sandbox` settings for a policy (ADR-0102): on, with no unsandboxed retry, the
 * policy's lists added to the person's own. Their other keys stay. The repository's secret files
 * need no entry here: the host adds its Read deny rules to the sandbox itself.
 */
function sandboxSettings(existing: unknown, policy: SandboxPolicy): Record<string, unknown> {
  const object = (v: unknown) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
  const added = (theirs: unknown, ours: readonly string[]) => {
    const kept = Array.isArray(theirs) ? (theirs as string[]) : [];
    return [...kept, ...ours.filter((o) => !kept.includes(o))];
  };
  /** A list is written when it has something, or when the person already had one. */
  const list = (holder: Record<string, unknown>, key: string, ours: readonly string[]) =>
    ours.length > 0 || Array.isArray(holder[key]) ? { [key]: added(holder[key], ours) } : {};
  const theirs = object(existing);
  const filesystem = object(theirs.filesystem);
  const network = object(theirs.network);
  return {
    ...theirs,
    enabled: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      ...filesystem,
      ...list(filesystem, "denyRead", policy.denyRead),
      ...list(filesystem, "allowWrite", policy.allowWrite),
    },
    network: { ...network, ...list(network, "allowedDomains", policy.allowedDomains) },
    ...list(theirs, "excludedCommands", policy.excludedCommands),
  };
}

/**
 * Claude Code deny rules for secrets, merges and commands that lose work. A path without a slash
 * matches at any depth; a `!` rule carves its files out of the rules before it, so the examples
 * follow the patterns they belong to. A command is listed with and without arguments.
 */
function denyRules(): string[] {
  const name = (glob: string) => glob.replace(/^(!?)\*\*\//, "$1");
  const secrets = SECRET_GLOBS.filter((g) => !g.startsWith("!"));
  const examples = SECRET_GLOBS.filter((g) => g.startsWith("!"));
  return [
    ...[...secrets, ...examples].map((g) => `Read(${name(g)})`),
    ...DENIED_COMMANDS.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]),
    ...MERGE_MCP_TOOLS.map((t) => `mcp__*__${t}`),
  ];
}

interface Group {
  readonly matcher?: string;
  readonly hooks: readonly { readonly type: string; readonly command?: string; readonly timeout?: number }[];
}
