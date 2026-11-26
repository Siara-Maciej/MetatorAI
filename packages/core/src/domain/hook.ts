import { parse, quote } from "shell-quote";
import { WORKER_RUN_CONTROL } from "./conductor.ts";
import { commandsOf } from "./discovery.ts";
import { matchesAny } from "./glob.ts";
import { DEFAULT_GUARD_COMMANDS, type GuardCommands, guardCommand } from "./guard-commands.ts";
import { asMetator, readOnlyCommand } from "./read-only-command.ts";
import type { Approval } from "./run-record.ts";
import { resolvePath } from "./shell-words.ts";
import {
  metatorRecord,
  personsMetatorCommand,
  type Unprompted,
  unpromptedCommand,
  unpromptedEdit,
} from "./unprompted.ts";

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
  /** The person's message (UserPromptSubmit). */
  readonly prompt?: string;
  /** The host's id of the session the hook runs in. */
  readonly sessionId?: string;
}

const text = (v: unknown) => (typeof v === "string" ? v : undefined);

export function readHookInput(raw: unknown): HookInput {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const input = (r.tool_input ?? r.toolInput ?? {}) as Record<string, unknown>;
  const cwd = text(r.cwd);
  const agent = text(r.agent_type) ?? text(r.agentType) ?? text(r.agent_name);
  const prompt = text(r.prompt) ?? text(r.user_prompt) ?? text(r.userPrompt);
  const sessionId = text(r.session_id) ?? text(r.sessionId);
  return {
    tool: text(r.tool_name) ?? text(r.toolName) ?? "",
    input: typeof input === "object" && input !== null ? input : {},
    ...(cwd ? { cwd } : {}),
    stopActive: r.stop_hook_active === true || r.stopHookActive === true,
    ...(agent ? { agent } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(sessionId ? { sessionId } : {}),
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

/** Why a driven agent may not move the run itself. */
export const DRIVEN_RUN_CONTROL = (command: string) =>
  `${command} is the drive's: \`metator run drive\` moves this run when your work is done. End with STATUS: done, or STATUS: blocked: <question>.`;

/** `run approve … --via chat` while nobody is attached: the person's consent in the chat counts only then. */
export const CHAT_APPROVAL_NEEDS_DRIVER =
  "an approval from the chat counts only while a person is attached to this session (`metator run attach`): nobody is, so it stays a person's to give (`metator run approve … --by <user>`).";

export interface PreToolContext {
  /** The session is one `metator run drive` started: the drive moves the run, never the agent. */
  readonly driven?: boolean;
  readonly root: string;
  /** The active run (status active), if any, with who drives it (absent: the agent). */
  readonly run?: {
    readonly id: string;
    readonly approvals: Readonly<Record<string, Approval>>;
    readonly driver?: "agent" | "human";
  };
  /** Exact files the plan allows to edit (plan-scope.json `edit`). */
  readonly editScope?: readonly string[];
  /** The calling agent is a coordinator (delegates, never edits). */
  readonly coordinator: boolean;
  /** The calling agent works a worker pane (R2): it reports, the conductor steers the run. */
  readonly worker?: boolean;
  /** `guard.commands` of the repository's config (ADR-0094); MetatorAI's defaults when absent. */
  readonly commands?: GuardCommands;
  /** The kinds the person consented to in words, still valid (`commit`, `push`, `commit-debug`). */
  readonly consents?: readonly string[];
  /** A drive's session without a terminal: nobody can be asked there, so an `ask` is a refusal. */
  readonly headless?: boolean;
  /** Debug changes (scratch) that a commit made now would hold. */
  readonly debugFiles?: readonly string[];
  /**
   * `guard.prompts: metator`: what the session may do without the host's approval prompt is
   * answered here (`unprompted.ts`). Absent (`host`): the guard only denies and asks.
   */
  readonly unprompted?: Omit<Unprompted, "cwd">;
}

export interface ToolDecision {
  /** `ask`: the host shows its own approval prompt (a card for the person). */
  readonly decision: "allow" | "deny" | "ask";
  readonly reason: string;
  /** The consents this call uses up (each holds for one command of its kind). */
  readonly consents?: readonly string[];
  /**
   * An `allow` the guard gives on its own (`guard.prompts: metator`): the host does not ask. A
   * plain `allow` is no opinion: the host's own permission rules apply.
   */
  readonly unprompted?: true;
}

const deny = (reason: string): ToolDecision => ({ decision: "deny", reason });

/** The consent that lets a commit with debug changes pass ("commit anyway"). */
export const COMMIT_DEBUG_CONSENT = "commit-debug";
/** Where the person's consents are kept: no agent writes there. */
export const CONSENTS_DIR = ".metator/consents";

/** Why no agent writes one of MetatorAI's records, and what it does instead. */
export const RECORD_WRITE = (path: string) =>
  `\`${path}\` is MetatorAI's own record (a run's stage, approvals and answers, its drive, the worktrees): only MetatorAI writes it, never an agent. Write your stage's artifacts with \`metator run write <artifact>\` (or a new file in the run directory); a gate's approval or a question's answer is the person's (\`metator run approve\`, \`metator run answer\`): end with STATUS: blocked: <question>.`;

/** A path as an absolute one, from where the tool stands. */
const absoluteFrom = (path: string, cwd: string): string => {
  const norm = path.replaceAll("\\", "/");
  return /^[A-Za-z]:\//.test(norm) ? norm : resolvePath(norm.startsWith("/") ? norm : `${cwd}/${norm}`);
};

/** The command without its here-documents' text (data, never a path written), one command per line. */
function commandLines(command: string): string {
  const bare = command.replace(
    /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1([^\n]*)\n(?:[\s\S]*?\n)?\t*\2[ \t]*(?=\n|$)/g,
    "$3",
  );
  let out = "";
  let quoted: string | undefined;
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i] as string;
    if (c === "\\" && quoted !== "'") {
      out += c + (bare[i + 1] ?? "");
      i++;
    } else if (quoted) {
      if (c === quoted) quoted = undefined;
      out += c;
    } else if (c === "'" || c === '"') {
      quoted = c;
      out += c;
    } else out += c === "\n" || c === "\r" ? ";" : c;
  }
  // Output thrown away or joined writes nothing.
  return out
    .replace(/(^|\s)[12]?>>?\s*\/dev\/null(?=$|[\s;&|])/g, "$1")
    .replace(/(^|\s)[12]>&[12](?=$|[\s;&|])/g, "$1");
}

/** `metator …` however it is started: MetatorAI's command writes only what is its own to write. */
const metatorCommand = (argv: readonly string[]) =>
  asMetator(argv) !== undefined ||
  (argv[0] ?? "").endsWith("/metator") ||
  (["bun", "node"].includes(argv[0] as string) && (argv[1] ?? "").endsWith("cli/src/main.ts"));

/** Commands that only read what they are given, besides those `readOnlyCommand` knows. */
const READERS = new Set(["jq"]);

/**
 * The record of MetatorAI's (`metatorRecord`) a shell command writes, as the command names it:
 * a redirection into one, or a command that does not only read and names one (by path, from the
 * directory the shell stands in, through a variable set before it, or inside a script's text).
 * Here-documents are data; `mkdir` only creates; MetatorAI's own commands write what is theirs.
 */
function shellRecordWrite(command: string, cwd: string): string | undefined {
  type Part = { argv: string[]; writes: string[] };
  const parts: Part[] = [{ argv: [], writes: [] }];
  let into = false;
  for (const token of parse(commandLines(command), (name) => `$${name}`)) {
    const part = parts.at(-1) as Part;
    if (typeof token === "string" || ("op" in token && token.op === "glob")) {
      (into ? part.writes : part.argv).push(typeof token === "string" ? token : token.pattern);
      into = false;
    } else if (!("op" in token)) {
      // A comment: nothing it says runs.
    } else if (token.op.startsWith(">")) into = true;
    else if (token.op === "<") into = false;
    else {
      parts.push({ argv: [], writes: [] });
      into = false;
    }
  }
  const vars = new Map<string, string>();
  let base = cwd;
  const expand = (word: string) =>
    word.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, name: string) => vars.get(name) ?? all);
  // The word itself, what follows `=`, and any `.metator/…` path inside it (a script's text).
  const record = (word: string): string | undefined => {
    const w = expand(word);
    const inside = w.match(/[^\s'"`()=,;:]*\.metator\b[^\s'"`()=,;:]*/g) ?? [];
    return [w, w.slice(w.indexOf("=") + 1), ...inside].find(
      (c) => c !== "" && !c.includes("$") && metatorRecord(absoluteFrom(c, base)),
    );
  };
  for (const { argv: words, writes } of parts) {
    const argv = [...words];
    while (argv[0] !== undefined && /^[A-Za-z_]\w*=/.test(argv[0])) {
      const [name, ...value] = (argv.shift() as string).split("=");
      vars.set(name as string, expand(value.join("=")));
    }
    const target = writes.map(record).find((r) => r !== undefined);
    if (target) return target;
    if (argv[0] === "cd" && argv.length === 2) {
      base = absoluteFrom(expand(argv[1] as string), base);
      continue;
    }
    if (argv.length === 0 || argv[0] === "mkdir" || metatorCommand(argv)) continue;
    const named = argv
      .slice(1)
      .map(record)
      .find((r) => r !== undefined);
    if (named === undefined) continue;
    const reads = READERS.has(argv[0] as string) || readOnlyCommand(quote(argv.map(expand)), ["/"]);
    if (!reads) return named;
  }
  return undefined;
}

/**
 * The record of MetatorAI's a tool call would write (an edit tool's file, a shell command's
 * target), as the call names it; undefined when it writes none. Paths are read from `cwd`.
 * Hosts check it in-process too, where no hook runs.
 */
export function recordWrite(hook: HookInput, cwd: string): string | undefined {
  if (isEditTool(hook.tool)) return touchedPaths(hook).find((p) => metatorRecord(absoluteFrom(p, cwd)));
  return SHELL_TOOL.test(hook.tool) ? shellRecordWrite(text(hook.input.command) ?? "", cwd) : undefined;
}

/** A command as a person reads it in a prompt: its words, cut when long. */
const shown = (argv: readonly string[]): string => {
  const text = argv.join(" ");
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
};

/** The run approval that covers a guarded command's kind: its own, or the push's for the commit before it. */
const approved = (kind: string, approvals: Readonly<Record<string, Approval>> | undefined): boolean =>
  approvals !== undefined &&
  (approvals[kind] !== undefined || (kind === "commit" && approvals.push !== undefined));

/** `metator guard …` in a shell command: a hook's command, which no agent runs itself. */
function guardCall(argv: readonly string[]): boolean {
  const at = argv.findIndex(
    (a) => a === "metator" || a.endsWith("/metator") || a.endsWith("cli/src/main.ts"),
  );
  return at >= 0 && argv.slice(at + 1).find((w) => !w.startsWith("-")) === "guard";
}

/** Which approval an external action needs: from a shell command or an MCP tool name. */
function externalAction(argv: readonly string[]): "push" | "comment" | undefined {
  const [tool, sub, verb] = argv;
  if (tool === "git" && argv.includes("push")) return "push";
  if (tool === "gh" && sub === "pr" && verb === "create") return "push";
  if (tool === "glab" && sub === "mr" && verb === "create") return "push";
  if (tool === "gh" && (sub === "pr" || sub === "issue") && (verb === "comment" || verb === "review"))
    return "comment";
  if (tool === "gh" && sub === "api" && argv.some((a) => /\/(comments|reviews)\b/.test(a))) return "comment";
  return undefined;
}

function mcpAction(tool: string): "push" | "comment" | undefined {
  if (!tool.startsWith("mcp__")) return undefined;
  if (
    /(create_pull_request|create_merge_request|push_files|create_or_update_file|delete_file|create_branch)$/.test(
      tool,
    )
  )
    return "push";
  if (/(comment|review)/.test(tool)) return "comment";
  return undefined;
}

/** Branches a change reaches only by a merge: a push straight to one is a merge too. */
export const HEAD_BRANCHES: readonly string[] = ["main", "master"];

/**
 * What a consent to a merge is given for. Every merge waits for the person's consent (ADR-0094's
 * `ask`): a click on the host's prompt or their word in the chat ("merge"). An approval given for
 * something else (a run's `push`, a consent to push) never covers one, and in a session nobody can
 * be asked in, a merge is refused. ADR-0099 made it `never`; the owner superseded that (2026-11-22).
 */
export const MERGE_KIND = "merge";

/** Where a `git push` argument lands: `src:dst`, `+name` and `refs/heads/…` name the branch `dst`. */
const pushTarget = (arg: string) =>
  (arg.includes(":") ? arg.slice(arg.lastIndexOf(":") + 1) : arg)
    .replace(/^\+/, "")
    .replace(/^refs\/heads\//, "");

/**
 * Commands that merge: a request at the code host (also its auto-merge and the REST call), or a
 * push straight to the head branch. `git merge` is on the config's own `ask` list.
 */
function merge(argv: readonly string[]): string | undefined {
  const [tool, sub, verb] = argv;
  if (tool === "gh" && sub === "pr" && verb === "merge") return "gh pr merge";
  if (tool === "glab" && sub === "mr" && (verb === "merge" || verb === "accept")) return `glab mr ${verb}`;
  if (
    (tool === "gh" || tool === "glab") &&
    sub === "api" &&
    argv.some((a) => /\/(pulls|merge_requests)\/\d+\/merge\b/.test(a))
  )
    return `${tool} api …/merge`;
  if (tool === "git" && sub === "push") {
    // The first plain argument is the remote; the rest say which branches the push writes.
    const head = argv
      .slice(2)
      .filter((a) => !a.startsWith("-"))
      .slice(1)
      .map(pushTarget)
      .find((b) => HEAD_BRANCHES.includes(b));
    if (head) return `git push to ${head}`;
  }
  return undefined;
}

/** MCP tools of a code host that merge a request or switch its auto-merge on, by the name they end with. */
export const MERGE_MCP_TOOLS: readonly string[] = [
  "merge_pull_request",
  "merge_merge_request",
  "accept_merge_request",
  "enable_pr_auto_merge",
  "enable_auto_merge",
];
const MCP_MERGE = new RegExp(`(${MERGE_MCP_TOOLS.join("|")})$`);

/**
 * The merge a tool call would make (a shell command, also inside a composite one, or an MCP tool),
 * or undefined. A host that runs in-process, where no hook runs, asks the person for it too.
 */
export function mergeAttempt(hook: HookInput): string | undefined {
  if (hook.tool.startsWith("mcp__")) return MCP_MERGE.test(hook.tool) ? hook.tool : undefined;
  if (!SHELL_TOOL.test(hook.tool)) return undefined;
  for (const argv of commandsOf(text(hook.input.command) ?? "")) {
    const what = merge(argv);
    if (what) return what;
  }
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

/**
 * The file a tool call would read or write that may hold secrets (`.env`, keys), by path or as a
 * shell argument; undefined when there is none. Hosts check it in-process too, where no hook runs.
 */
export function secretPath(hook: HookInput, root: string): string | undefined {
  const shell = SHELL_TOOL.test(hook.tool) ? commandsOf(text(hook.input.command) ?? "") : [];
  const secretArgs = shell.flatMap((argv) => argv.slice(1)).filter((a) => !a.startsWith("-"));
  return [...touchedPaths(hook), ...secretArgs].find((p) => {
    const rel = repoRelative(p, root) ?? p.replaceAll("\\", "/");
    return matchesAny(rel.startsWith("/") ? rel.slice(1) : rel, SECRET_GLOBS);
  });
}

/** `metator run` subcommands that move or end a run: the drive's to call, never a driven agent's. */
const RUN_CONTROL = new Set([
  "advance",
  "approve",
  "answer",
  "stop",
  "close",
  "resume",
  "drive",
  "continue",
  // `run new` and its old spelling `run init`: both start a run.
  "new",
  "init",
  "start",
  "delegate",
  "collect",
]);

/**
 * The run-control command a tool call runs (`metator run advance pass`), or undefined. In a run
 * `metator run drive` carries, the drive moves the run when a stage's work is done; an agent that
 * advances it itself makes the drive's own event land on the next stage, which is then skipped.
 */
export function runControlCommand(hook: HookInput): string | undefined {
  if (!SHELL_TOOL.test(hook.tool)) return undefined;
  for (const argv of commandsOf(text(hook.input.command) ?? "")) {
    const at = argv.findIndex(
      (a) => a === "metator" || a.endsWith("/metator") || a.endsWith("cli/src/main.ts"),
    );
    if (at < 0) continue;
    const words = argv.slice(at + 1).filter((w) => !w.startsWith("-"));
    const i = words.indexOf("run");
    if (i >= 0 && RUN_CONTROL.has(words[i + 1] ?? "")) return `metator run ${words[i + 1]}`;
  }
  return undefined;
}

/**
 * `metator run approve <gate> --by <who> --via chat`, alone: what an agent runs after a person
 * said yes in the chat. It counts only while that person is attached (ADR-0077).
 */
export function chatApproval(hook: HookInput): boolean {
  if (!SHELL_TOOL.test(hook.tool)) return false;
  const commands = commandsOf(text(hook.input.command) ?? "");
  if (commands.length !== 1) return false;
  const argv = commands[0] as readonly string[];
  const at = argv.findIndex(
    (a) => a === "metator" || a.endsWith("/metator") || a.endsWith("cli/src/main.ts"),
  );
  if (at < 0) return false;
  const rest = argv.slice(at + 1);
  const via = rest.indexOf("--via");
  return rest[0] === "run" && rest[1] === "approve" && via > 0 && rest[via + 1] === "chat";
}

/**
 * The pre-tool decision. First the rules that deny and ask (`rules`); then, for a call they have
 * no objection to and where the repository lets MetatorAI answer (`guard.prompts: metator`),
 * whether it needs the host's approval prompt at all.
 */
export function preToolPolicy(hook: HookInput, ctx: PreToolContext): ToolDecision {
  const judged = rules(hook, ctx);
  // A denial, an `ask`, and an allow that used the person's consent stand as they are.
  if (judged.decision !== "allow" || judged.consents || !ctx.unprompted) return judged;
  const u: Unprompted = { ...ctx.unprompted, ...(hook.cwd ? { cwd: hook.cwd } : {}) };
  if (SHELL_TOOL.test(hook.tool)) {
    const command = text(hook.input.command) ?? "";
    // A person's decision, or the guard's own setup: MetatorAI's command, yet theirs to let run.
    const persons = ctx.headless ? undefined : personsMetatorCommand(commandsOf(command), u);
    if (persons)
      return {
        decision: "ask",
        reason: `\`${persons}\` records a person's decision or changes what guards the agent: answer here to let it run.`,
      };
    const why = unpromptedCommand(command, u);
    return why ? { decision: "allow", reason: `no approval needed: ${why}`, unprompted: true } : judged;
  }
  if (isEditTool(hook.tool)) {
    const why = unpromptedEdit(touchedPaths(hook), u);
    return why ? { decision: "allow", reason: `no approval needed: ${why}`, unprompted: true } : judged;
  }
  return judged;
}

function rules(hook: HookInput, ctx: PreToolContext): ToolDecision {
  const paths = touchedPaths(hook);
  const shell = SHELL_TOOL.test(hook.tool) ? commandsOf(text(hook.input.command) ?? "") : [];

  // Secrets are never read or written, with or without a run (MT-SEC).
  const secret = secretPath(hook, ctx.root);
  if (secret) return deny(`${secret} may hold secrets; agents do not read or write it.`);
  // A worker pane reports and finishes; the conductor moves the run (R2).
  const steering = ctx.worker ? runControlCommand(hook) : undefined;
  if (steering) return deny(WORKER_RUN_CONTROL(steering));
  const control = ctx.driven ? runControlCommand(hook) : undefined;
  if (control) {
    // A person's yes in the chat, carried by the agent: only while that person holds the session.
    if (!chatApproval(hook)) return deny(DRIVEN_RUN_CONTROL(control));
    if (ctx.run?.driver !== "human") return deny(CHAT_APPROVAL_NEEDS_DRIVER);
  }
  // The person's consents are theirs to give: no agent calls a guard or writes where they are kept.
  if (shell.some(guardCall))
    return deny(
      "`metator guard` is the host's hook, never an agent's command: a consent is the person's own word.",
    );
  const raw = text(hook.input.command) ?? "";
  if (
    raw.includes(CONSENTS_DIR) ||
    paths.some((p) => (repoRelative(p, ctx.root) ?? p).replaceAll("\\", "/").startsWith(`${CONSENTS_DIR}/`))
  )
    return deny(`${CONSENTS_DIR} holds the person's consents: only their own words in the chat write there.`);
  // A run's approvals and answers are MetatorAI's records: an agent that wrote them would pass its own gate.
  const record = recordWrite(hook, hook.cwd ?? ctx.root);
  if (record) return deny(RECORD_WRITE(record));

  // Dangerous commands, from the one list in the config (ADR-0094): never, or with consent.
  const commands = ctx.commands ?? DEFAULT_GUARD_COMMANDS;
  /** What the call needs the person's consent for, and the words the prompt shows. */
  const asked: { readonly kind: string; readonly what: string }[] = [];
  for (const argv of shell) {
    const verdict = guardCommand(argv, commands);
    if (verdict.level === "never")
      return deny(
        `\`${shown(argv)}\` never runs here (guard.commands.never: ${verdict.pattern}): it can lose work or rewrite history. If the person wants it, they run it themselves.`,
      );
    const approve = planApproval(argv);
    if (approve)
      return deny(`${approve} is the user's decision: show what to approve and ask the user to run it.`);
    // A merge asks whatever the lists allow, and a consent to push does not cover one.
    if (merge(argv)) asked.push({ kind: MERGE_KIND, what: shown(argv) });
    else if (verdict.level === "ask" && verdict.kind !== undefined)
      asked.push({ kind: verdict.kind, what: shown(argv) });
  }
  if (hook.tool.startsWith("mcp__") && mergeAttempt(hook)) asked.push({ kind: MERGE_KIND, what: hook.tool });
  const used: string[] = [];
  let ask: string | undefined;
  for (const { kind, what } of asked) {
    const debug = kind === "commit" ? (ctx.debugFiles ?? []) : [];
    if (debug.length > 0) {
      // Debug changes in a commit: stopped whatever was consented, until the person says "anyway".
      if (ctx.consents?.includes(COMMIT_DEBUG_CONSENT)) used.push(COMMIT_DEBUG_CONSENT);
      else {
        ask ??= `this commit holds debug changes: ${debug.join(", ")}. Remove them first (\`metator scratch drop\`), or answer here to commit anyway.`;
        continue;
      }
    }
    if (approved(kind, ctx.run?.approvals)) continue;
    if (ctx.consents?.includes(kind)) {
      used.push(kind);
      continue;
    }
    if (ctx.headless)
      return deny(
        ctx.run && (kind === "push" || kind === "commit")
          ? `${kind} needs the user's approval: show the report and options, then \`metator run approve push --by <user>\`.`
          : `${kind} needs the person's consent, and nobody can be asked in this session: end with STATUS: blocked and say what to ${kind}.`,
      );
    ask ??= ctx.run
      ? `\`${what}\` needs your consent: answer here, say it in the chat ("${kind}"), or \`metator run approve ${kind === "commit" ? "push" : kind} --by <user>\`.`
      : `\`${what}\` needs your consent: answer here, or say it in the chat ("${kind}").`;
  }
  if (ask) return { decision: "ask", reason: ask };
  const consented: ToolDecision | undefined =
    used.length > 0
      ? {
          decision: "allow",
          reason: `the person consented to ${used.filter((k) => k !== COMMIT_DEBUG_CONSENT).join(" and ") || "commit"} in the chat`,
          consents: used,
        }
      : undefined;
  if (!ctx.run) return consented ?? { decision: "allow", reason: "no active run" };

  // What the config's list already decided (a git push with consent or approval) is not asked twice.
  const governed = (argv: readonly string[]) =>
    merge(argv) !== undefined || guardCommand(argv, commands).level === "ask";
  const action =
    mcpAction(hook.tool) ??
    shell
      .filter((argv) => !governed(argv))
      .map(externalAction)
      .find((a) => a !== undefined);
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
      if (rel.startsWith(".metator/")) continue; // run artifacts are always writable; records were denied above
      if (ctx.editScope && !ctx.editScope.includes(rel))
        return deny(`${rel} is outside plan-scope.json; update the plan (mt-planner) or ask the user.`);
    }
  }
  return consented ?? { decision: "allow", reason: "ok" };
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

/** The shell commands a tool call runs (none for another tool). */
export const commandsOfHook = (hook: HookInput): string[][] =>
  SHELL_TOOL.test(hook.tool) ? commandsOf(text(hook.input.command) ?? "") : [];

/** Extra context for the model (SessionStart, PostToolUse, UserPromptSubmit). */
export function contextResponse(
  event: "SessionStart" | "PostToolUse" | "UserPromptSubmit",
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
  readonly event:
    | "SessionStart"
    | "UserPromptSubmit"
    | "PreToolUse"
    | "PostToolUse"
    | "SubagentStop"
    | "PreCompact"
    | "Stop";
  readonly guard: string;
  readonly timeout: number;
  /** Tools the hook applies to (a regex for hosts with matchers); all tools when omitted. */
  readonly matcher?: string;
}[] = [
  { event: "SessionStart", guard: "session-start", timeout: 10 },
  // The person's own message: a consent in words to a guarded command (ADR-0094).
  { event: "UserPromptSubmit", guard: "user-prompt", timeout: 5 },
  { event: "PreToolUse", guard: "pre-tool", timeout: 5 },
  { event: "PostToolUse", guard: "post-edit", timeout: 30, matcher: EDIT_TOOL.source.slice(2, -2) },
  { event: "SubagentStop", guard: "subagent-output", timeout: 10 },
  { event: "PreCompact", guard: "precompact", timeout: 10 },
  { event: "Stop", guard: "stop", timeout: 10 },
];

/** True for a hook command that a MetatorAI generator wrote (any metator command prefix). */
export const isGuardCommand = (command: unknown) =>
  typeof command === "string" && / guard [a-z-]+$/.test(command);
