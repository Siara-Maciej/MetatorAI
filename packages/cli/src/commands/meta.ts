import { ok } from "@metator/core";
import type { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import type { CommandContext } from "../context.ts";

export interface CommandInfo {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
}

/** Machine-readable help built from commander's own command tree (single source of truth). */
export function describeCommands(program: Command): { commands: CommandInfo[] } {
  const commands: CommandInfo[] = [];
  const walk = (cmd: Command, prefix: string) => {
    for (const sub of cmd.commands) {
      const name = `${prefix}${sub.name()}`;
      // A group is listed itself only when it also runs on its own (`metator run`, `metator ask`).
      const runsItself = (sub as unknown as { _actionHandler?: unknown })._actionHandler != null;
      if (sub.commands.length === 0 || runsItself)
        commands.push({ name, summary: sub.description(), usage: `metator ${name} ${sub.usage()}`.trim() });
      if (sub.commands.length > 0) walk(sub, `${name} `);
    }
  };
  walk(program, "");
  return { commands };
}

export interface CommandHelp extends CommandInfo {
  readonly options: { readonly flags: string; readonly description: string; readonly default?: unknown }[];
  readonly commands?: CommandInfo[];
}

/**
 * `metator <command> --help`: the command the words before the flag name, with its options (and
 * the commands of a group). `--help` with no command, or after `--`, is the whole list.
 */
export function describeCommandFor(program: Command, argv: readonly string[]): CommandHelp | undefined {
  const end = argv.indexOf("--");
  const words = end === -1 ? argv : argv.slice(0, end);
  if (!words.some((a) => a === "--help" || a === "-h")) return undefined;
  let cmd = program;
  const path: string[] = [];
  for (const word of words) {
    const sub = cmd.commands.find((c) => c.name() === word || c.aliases().includes(word));
    if (!sub) break;
    cmd = sub;
    path.push(sub.name());
  }
  if (path.length === 0) return undefined;
  const name = path.join(" ");
  const commands = cmd.commands.length > 0 ? describeCommands(cmd).commands : undefined;
  return {
    name,
    summary: cmd.description(),
    usage: `metator ${name} ${cmd.usage()}`.trim(),
    options: cmd.options.map((o) => ({
      flags: o.flags,
      description: o.description,
      ...(o.defaultValue !== undefined ? { default: o.defaultValue } : {}),
    })),
    ...(commands ? { commands: commands.map((c) => ({ ...c, name: `${name} ${c.name}` })) } : {}),
  };
}

/**
 * The commands a person reaches for, by what they want to do (P8): the verbs, not the whole tree.
 * `metator help --verbs` prints it as data; a person at a terminal with no command sees it as text.
 */
export const VERBS: readonly { readonly verb: string; readonly commands: readonly [string, string][] }[] = [
  {
    verb: "Set up a repository",
    commands: [
      ["setup", "hosts, workflows and hooks, asked in the terminal (or --host … --yes)"],
      ["init", "the config from the repository's own scripts, with the evidence"],
      ["doctor", "what a run will not be able to do here, and the fix for each"],
      ["agents update", "take the newer canon, keeping the files you changed"],
      ["generate", "the host files (Copilot, Claude Code) from the canonical agents"],
    ],
  },
  {
    verb: "Work on a task",
    commands: [
      ["run", "start a run in the terminal: workflow, task, host, then follow it"],
      ["run init", "a run from a workflow and a task (--worktree for its own checkout)"],
      ["run start", "the run as a conductor pane under the daemon; workers in their own panes"],
      ["run drive", "the run headless, stage by stage, asking you when a gate needs you"],
      ["run status", "the stage the run stands at and what it expects"],
      ["inbox", "every question waiting for you, the most urgent first"],
      ["run answer", "answer a question; --always makes it a policy"],
      ["issue list", "the backlog: agents' proposals that wait for you, then the open tasks"],
      ["issue start", "a run on a task of the backlog, in a new worktree"],
      ["review changes", "what a run changed, file by file, with one file's diff"],
      ["review notes add", "a note on a line of the change; `review notes send` hands them to the agent"],
      ["open", "your editor on the run's worktree, at a file and line"],
      ["attach", "your terminal on a pane (or a run's conductor); Ctrl-] detaches"],
      ["status", "every run at a glance: who waits for you, who works, who stopped"],
      ["ui", "the full-screen view of every session"],
    ],
  },
  {
    verb: "Understand the code",
    commands: [
      ["ask", "a question about the code, answered with file:line citations"],
      ["graph affected", "the files and tests a change touches"],
      ["graph dependents", "who imports a file, directly or through others"],
      ["symbols find", "where an exported name is defined and re-exported"],
      ["cards build", "one card per package: facts from the code plus your notes"],
      ["owners", "who owns a path (CODEOWNERS)"],
    ],
  },
  {
    verb: "Check and review",
    commands: [
      ["gate", "the repository's quality gates, as agents and CI run them"],
      ["rules check", "the canon's rules against a change"],
      ["arch check", "package architecture against the policy; only new violations"],
      ["review plan", "the review of a change: shards, lenses, rules"],
      ["findings to-github", "verified findings as PR comments"],
      ["workflow lint", "the workflow specs against the anatomy they must have"],
    ],
  },
  {
    verb: "Many repositories",
    commands: [
      ["repos", "a folder of repositories: list, init, status"],
      ["system", "the system map: contracts between applications, impact, plans"],
    ],
  },
  {
    verb: "Keep it running",
    commands: [
      ["serve", "the local daemon: state, inbox, terminals, the desktop app's backend"],
      ["supervise", "restart dead drives, nudge idle sessions, mind the attention budget"],
      ["worktree", "worktrees and their ports: new, list, rm, prune"],
      ["env", "the application's environment per worktree: up, down, status, logs"],
      ["report", "what the runs cost and gave back"],
    ],
  },
];

export interface Overview {
  readonly version: string;
  readonly verbs: readonly { readonly verb: string; readonly commands: readonly CommandInfo[] }[];
  /** How many commands there are in all; `metator help` lists them. */
  readonly total: number;
}

/** The verbs with each command's real summary from the tree; a verb entry names only commands that exist. */
export function describeOverview(program: Command): Overview {
  const all = describeCommands(program).commands;
  const byName = new Map(all.map((c) => [c.name, c]));
  return {
    version: pkg.version,
    verbs: VERBS.map((g) => ({
      verb: g.verb,
      commands: g.commands.map(([name, said]) => {
        const known = byName.get(name);
        return { name, summary: said, usage: known?.usage ?? `metator ${name}` };
      }),
    })),
    total: all.length,
  };
}

/** The overview as a person reads it (stderr, with the one JSON line kept for stdout). */
export function renderOverview(o: Overview): string {
  const width = Math.max(...o.verbs.flatMap((g) => g.commands.map((c) => c.name.length)));
  const lines = [`MetatorAI ${o.version}: survey first, prove everything.`, ""];
  for (const g of o.verbs) {
    lines.push(g.verb);
    for (const c of g.commands) lines.push(`  metator ${c.name.padEnd(width)}  ${c.summary}`);
    lines.push("");
  }
  lines.push(`${o.total} commands in all: \`metator help\`; one command: \`metator <command> --help\`.`);
  return lines.join("\n");
}

export function registerMetaCommands(program: Command, { action, terminal }: CommandContext): void {
  program
    .command("version")
    .description("Print the MetatorAI version")
    .action(action(() => ({ result: ok({ name: "metator-ai", version: pkg.version }) })));

  program
    .command("help")
    .description("List available commands (--verbs: the ones a person reaches for, by what they want to do)")
    .option("--verbs", "the overview by verb instead of the whole list", false)
    .action(
      action((opts: { verbs: boolean }) => {
        if (!opts.verbs) return { result: ok(describeCommands(program)) };
        const overview = describeOverview(program);
        terminal?.raw(`${renderOverview(overview)}\n`);
        return { result: ok(overview) };
      }),
    );
}
