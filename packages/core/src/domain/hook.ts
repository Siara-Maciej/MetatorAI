import { commandsOf } from "./discovery.ts";
import { matchesAny } from "./glob.ts";
import type { Approval } from "./run-record.ts";

/**
 * Host hooks (`metator guard <event>`, ADR-0038). Hosts send a JSON payload on stdin and read a
 * decision from stdout. Claude Code and VS Code Copilot share the format (`tool_name`,
 * `tool_input`, `hookSpecificOutput`); the readers accept camelCase spellings too, so the
 * format lives only here.
 */
export interface HookInput {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
  /** Claude Code sets it when a Stop hook already made the agent continue once. */
  readonly stopActive: boolean;
  /** The agent that runs the tool, when the host says (subagents). */
  readonly agent?: string;
}

const text = (v: unknown) => (typeof v === "string" ? v : undefined);

export function readHookInput(raw: unknown): HookInput {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const input = (r.tool_input ?? r.toolInput ?? {}) as Record<string, unknown>;
  const cwd = text(r.cwd);
  const agent = text(r.agent_type) ?? text(r.agentType) ?? text(r.agent_name);
  return {
    tool: text(r.tool_name) ?? text(r.toolName) ?? "",
    input: typeof input === "object" && input !== null ? input : {},
    ...(cwd ? { cwd } : {}),
    stopActive: r.stop_hook_active === true || r.stopHookActive === true,
    ...(agent ? { agent } : {}),
  };
}

/** Tools that write files (Claude Code and Copilot names). */
const EDIT_TOOL =
  /^(Edit|MultiEdit|Write|NotebookEdit|create_file|edit_file|insert_edit_into_file|replace_string_in_file|multi_replace_string_in_file|apply_patch|edit_notebook_file)$/i;
const SHELL_TOOL = /^(Bash|run_in_terminal|shell|terminal)$/i;

export const isEditTool = (tool: string) => EDIT_TOOL.test(tool);

/** Files a tool call reads or writes, as the host named them (absolute or relative). */
export function touchedPaths(hook: HookInput): string[] {
  const out = new Set<string>();
  for (const key of ["file_path", "filePath", "path", "notebook_path", "notebookPath"]) {
    const v = text(hook.input[key]);
    if (v) out.add(v);
  }
  const patch = text(hook.input.input) ?? text(hook.input.patch);
  if (patch)
    for (const [, p] of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm))
      out.add((p as string).trim());
  return [...out];
}

/** Repo-relative path, or undefined for a path outside the repository. */
export function repoRelative(path: string, root: string): string | undefined {
  const norm = path.replaceAll("\\", "/");
  const base = root.replaceAll("\\", "/").replace(/\/$/, "");
  if (!norm.startsWith("/") && !/^[A-Za-z]:\//.test(norm)) return norm.replace(/^\.\//, "");
  if (norm === base) return ".";
  return norm.startsWith(`${base}/`) ? norm.slice(base.length + 1) : undefined;
}

export const SECRET_GLOBS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "!**/.env.example",
  "!**/.env.sample",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.netrc",
];

export interface PreToolContext {
  readonly root: string;
  /** The active run (status active), if any. */
  readonly run?: { readonly id: string; readonly approvals: Readonly<Record<string, Approval>> };
  /** Exact files the plan allows to edit (plan-scope.json `edit`). */
  readonly editScope?: readonly string[];
  /** The calling agent is a coordinator (delegates, never edits). */
  readonly coordinator: boolean;
}

export interface ToolDecision {
  readonly decision: "allow" | "deny";
  readonly reason: string;
}

const deny = (reason: string): ToolDecision => ({ decision: "deny", reason });

/** Which approval an external action needs: from a shell command or an MCP tool name. */
function externalAction(argv: readonly string[]): "push" | "comment" | undefined {
  const [tool, sub, verb] = argv;
  if (tool === "git" && argv.includes("push")) return "push";
  if (tool === "gh" && sub === "pr" && (verb === "create" || verb === "merge")) return "push";
  if (tool === "gh" && (sub === "pr" || sub === "issue") && (verb === "comment" || verb === "review"))
    return "comment";
  if (tool === "gh" && sub === "api" && argv.some((a) => /\/(comments|reviews)\b/.test(a))) return "comment";
  return undefined;
}

function mcpAction(tool: string): "push" | "comment" | undefined {
  if (!tool.startsWith("mcp__")) return undefined;
  if (
    /(create_pull_request|merge_pull_request|push_files|create_or_update_file|delete_file|create_branch)$/.test(
      tool,
    )
  )
    return "push";
  if (/(comment|review)/.test(tool)) return "comment";
  return undefined;
}

/** Commands no agent runs: they lose work or rewrite shared history. */
function destructive(argv: readonly string[]): string | undefined {
  const [tool, sub] = argv;
  if (tool === "git" && sub === "push" && argv.some((a) => /^(-f|--force|--force-with-lease)(=.*)?$/.test(a)))
    return "git push --force";
  if (tool === "git" && sub === "reset" && argv.includes("--hard")) return "git reset --hard";
  if (tool === "git" && sub === "clean" && argv.some((a) => /^-[a-z]*f/.test(a))) return "git clean -f";
  if (
    tool === "rm" &&
    argv.some((a) => /^-[a-z]*r/i.test(a)) &&
    argv.some((a) => ["/", "~", ".", "..", "*", "/*"].includes(a))
  )
    return "rm -r of a root, home or the whole tree";
  return undefined;
}

/**
 * A plan's approval is the person's: no agent runs `metator arch plan approve` or `metator system
 * plan approve` (the plan's author is an agent; run gates keep their own relay through
 * `metator run approve`).
 */
function planApproval(argv: readonly string[]): string | undefined {
  const at = argv.findIndex(
    (a) => a === "metator" || a.endsWith("/metator") || a.endsWith("cli/src/main.ts"),
  );
  if (at < 0) return undefined;
  // Options and their values (`-C ../shop`) may come first: look for the three words in a row.
  const words = argv.slice(at + 1);
  for (const group of ["arch", "system"]) {
    const i = words.indexOf(group);
    if (i >= 0 && words[i + 1] === "plan" && words[i + 2] === "approve")
      return `metator ${group} plan approve`;
  }
  return undefined;
}

export function preToolPolicy(hook: HookInput, ctx: PreToolContext): ToolDecision {
  const paths = touchedPaths(hook);
  const shell = SHELL_TOOL.test(hook.tool) ? commandsOf(text(hook.input.command) ?? "") : [];

  // Secrets are never read or written, with or without a run (MT-SEC).
  const secretArgs = shell.flatMap((argv) => argv.slice(1)).filter((a) => !a.startsWith("-"));
  for (const p of [...paths, ...secretArgs]) {
    const rel = repoRelative(p, ctx.root) ?? p.replaceAll("\\", "/");
    if (matchesAny(rel.startsWith("/") ? rel.slice(1) : rel, SECRET_GLOBS))
      return deny(`${p} may hold secrets; agents do not read or write it.`);
  }
  for (const argv of shell) {
    const what = destructive(argv);
    if (what) return deny(`${what} is blocked: it can lose work. Ask the user to run it.`);
    const approve = planApproval(argv);
    if (approve)
      return deny(`${approve} is the user's decision: show what to approve and ask the user to run it.`);
  }
  if (!ctx.run) return { decision: "allow", reason: "no active run" };

  const action = mcpAction(hook.tool) ?? shell.map(externalAction).find((a) => a !== undefined);
  if (action && !ctx.run.approvals[action]) {
    return deny(
      `${action} needs the user's approval: show the report and options, then \`metator run approve ${action} --by <user>\`.`,
    );
  }

  if (isEditTool(hook.tool)) {
    if (ctx.coordinator)
      return deny("Coordinators delegate and do not edit files; hand the step to a worker.");
    for (const p of paths) {
      const rel = repoRelative(p, ctx.root);
      if (rel === undefined) return deny(`${p} is outside the repository.`);
      if (rel.startsWith(".metator/")) continue; // run artifacts are always writable
      if (ctx.editScope && !ctx.editScope.includes(rel))
        return deny(`${rel} is outside plan-scope.json; update the plan (mt-planner) or ask the user.`);
    }
  }
  return { decision: "allow", reason: "ok" };
}

/** PreToolUse answer: a permission decision with its reason. */
export function permissionResponse(d: ToolDecision): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: d.decision,
      permissionDecisionReason: d.reason,
    },
  };
}

/** Extra context for the model (SessionStart, PostToolUse). */
export function contextResponse(
  event: "SessionStart" | "PostToolUse",
  context: string,
): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

/** Stop / SubagentStop: keep the agent working, with what is missing. */
export function blockResponse(reason: string): Record<string, unknown> {
  return { decision: "block", reason };
}

/** Which guard answers which host event (05-templates §10); timeouts in seconds. */
export const HOOK_BINDINGS: readonly {
  readonly event: "SessionStart" | "PreToolUse" | "PostToolUse" | "SubagentStop" | "PreCompact" | "Stop";
  readonly guard: string;
  readonly timeout: number;
  /** Tools the hook applies to (a regex for hosts with matchers); all tools when omitted. */
  readonly matcher?: string;
}[] = [
  { event: "SessionStart", guard: "session-start", timeout: 10 },
  { event: "PreToolUse", guard: "pre-tool", timeout: 5 },
  { event: "PostToolUse", guard: "post-edit", timeout: 30, matcher: EDIT_TOOL.source.slice(2, -2) },
  { event: "SubagentStop", guard: "subagent-output", timeout: 10 },
  { event: "PreCompact", guard: "precompact", timeout: 10 },
  { event: "Stop", guard: "stop", timeout: 10 },
];

/** True for a hook command that a MetatorAI generator wrote (any metator command prefix). */
export const isGuardCommand = (command: unknown) =>
  typeof command === "string" && / guard [a-z-]+$/.test(command);
