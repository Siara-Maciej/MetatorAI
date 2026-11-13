import { ok } from "@metator/core";
import { type Command, Option } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { AUDIENCES, type Audience, commandsFor, everyCommand, meta, metaOf } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { renderCommandList } from "../render.ts";

export interface CommandInfo {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
}

/**
 * Machine-readable help built from commander's own command tree (single source of truth). A
 * command's old spelling still runs and is not listed, unless `renamed` asks for it (the MCP
 * tools keep the names they had).
 */
export function describeCommands(
  program: Command,
  { renamed = false }: { readonly renamed?: boolean } = {},
): { commands: CommandInfo[] } {
  const commands: CommandInfo[] = [];
  const walk = (cmd: Command, prefix: string) => {
    for (const sub of cmd.commands) {
      if (metaOf(sub).renamedTo && !renamed) continue;
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

/** The command the words name, skipping the options (with their values) of the commands on the way. */
function commandAt(
  program: Command,
  words: readonly string[],
): { readonly cmd: Command; readonly path: readonly string[]; readonly rest: readonly string[] } {
  let cmd = program;
  const path: string[] = [];
  let i = 0;
  for (; i < words.length; i++) {
    const word = words[i] as string;
    const sub = cmd.commands.find((c) => c.name() === word || c.aliases().includes(word));
    if (sub) {
      cmd = sub;
      path.push(sub.name());
      continue;
    }
    // `-C <dir>` and `--root <dir>` (or `--root=<dir>`) before the command are not its name.
    const flag = word.split("=")[0] as string;
    const option = cmd.options.find((o) => o.short === flag || o.long === flag);
    if (!option) break;
    if ((option.required || option.optional) && !word.includes("=")) i++;
  }
  return { cmd, path, rest: words.slice(i) };
}

/** The options a person is shown: a renamed flag's old spelling still parses and is not listed. */
export const visibleOptions = (cmd: Command) => cmd.options.filter((o) => !o.hidden);

function helpOf(cmd: Command, path: readonly string[]): CommandHelp {
  const name = path.join(" ");
  const commands = cmd.commands.length > 0 ? describeCommands(cmd).commands : undefined;
  return {
    name,
    summary: cmd.description(),
    usage: `metator ${name} ${cmd.usage()}`.trim(),
    options: visibleOptions(cmd).map((o) => ({
      flags: o.flags,
      description: o.description,
      ...(o.defaultValue !== undefined ? { default: o.defaultValue } : {}),
    })),
    // A group's commands carry the group in their name and their usage, as the whole list does.
    ...(commands
      ? {
          commands: commands.map((c) => ({
            ...c,
            name: `${name} ${c.name}`,
            usage: `metator ${name} ${c.usage.slice("metator ".length)}`,
          })),
        }
      : {}),
  };
}

/**
 * `metator <command> --help`: the command the words before the flag name, with its options (and
 * the commands of a group). `--help` with no command, or after `--`, is the whole list. A group
 * that does not run on its own, typed bare (`metator repos`), is its help too.
 */
export function describeCommandFor(program: Command, argv: readonly string[]): CommandHelp | undefined {
  const end = argv.indexOf("--");
  const words = end === -1 ? argv : argv.slice(0, end);
  const asked = words.some((a) => a === "--help" || a === "-h");
  const { cmd, path, rest } = commandAt(program, words);
  if (path.length === 0) return undefined;
  if (asked) return helpOf(cmd, path);
  const runsItself = (cmd as unknown as { _actionHandler?: unknown })._actionHandler != null;
  const bareGroup = rest.length === 0 && end === -1 && cmd.commands.length > 0 && !runsItself;
  return bareGroup ? helpOf(cmd, path) : undefined;
}

/**
 * The commands a person reaches for, by what they want to do (P8): the verbs, not the whole tree.
 * `metator help --verbs` prints it as data; a person at a terminal with no command sees it as text.
 */
export const VERBS: readonly { readonly verb: string; readonly commands: readonly [string, string][] }[] = [
  {
    verb: "Set up a repository",
    commands: [
      ["setup", "AI hosts, workflows and hooks, asked in the terminal (or --host … --yes)"],
      ["init", "the config from the repository's own scripts, with the evidence"],
      ["doctor", "what a run will not be able to do here, and the fix for each"],
      ["agents update", "take the newer shipped files, keeping the ones you changed"],
      ["generate", "the AI hosts' files (Copilot, Claude Code) from the shipped agents and skills"],
    ],
  },
  {
    verb: "Work on a task",
    commands: [
      ["run", "start a run in the terminal: workflow, task, AI host, then follow it"],
      ["run new", "a run from a workflow and a task (--worktree for its own checkout)"],
      ["run start", "the run in an agent's pane under the daemon; its workers in their own panes"],
      ["run drive", "the run without a terminal of its own, stage by stage, asking you at each approval"],
      ["run status", "the stage the run stands at and what it expects"],
      ["inbox", "every question waiting for you, the most urgent first"],
      ["run answer", "answer a question; --always makes it a policy"],
      ["issue list", "the backlog: agents' proposals that wait for you, then the open tasks"],
      ["intake scan", "outside issues (GitHub, GitLab, Jira) become tasks and runs under the intake rules"],
      ["mrs list", "reviews of my open pull requests: threads, proposed replies, the answering run"],
      ["issue start", "a run on a task of the backlog, in a new worktree"],
      ["review changes", "what a run changed, file by file, with one file's diff"],
      ["review notes add", "a note on a line of the change; `review notes send` hands them to the agent"],
      ["open", "your editor on the run's worktree, at a file and line"],
      ["attach", "your terminal on a pane (or a run's conductor); Ctrl-] detaches"],
      ["status", "every run at a glance: who waits for you, who works, who stopped"],
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
      ["rules check", "the repository's rules against a change"],
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
      ["supervise", "restart dead drives, nudge idle agents, mind the attention budget"],
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
  // The verbs give the order and the words; which commands are a person's is what each says
  // of itself where it is registered (`audience: "person"`).
  const persons = new Set(commandsFor(program, "person"));
  return {
    version: pkg.version,
    verbs: VERBS.map((g) => ({
      verb: g.verb,
      commands: g.commands
        .filter(([name]) => persons.has(name))
        .map(([name, said]) => {
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

/** The commands of an audience, with each one's summary and usage (a group too, when it names the audience). */
export function describeAudience(
  program: Command,
  audience: Audience,
): { audience: Audience; commands: CommandInfo[] } {
  const wanted = new Set(commandsFor(program, audience));
  return {
    audience,
    commands: everyCommand(program)
      .filter((c) => wanted.has(c.name))
      .map((c) => ({
        name: c.name,
        summary: c.cmd.description(),
        usage: `metator ${c.name} ${c.cmd.usage()}`.trim(),
      })),
  };
}

export function registerMetaCommands(program: Command, { action }: CommandContext): void {
  meta(program.command("version"), { reads: true, folder: true })
    .description("Print the MetatorAI version")
    .action(action(() => ({ result: ok({ name: "metator-ai", version: pkg.version }) })));

  meta(program.command("help"), {
    reads: true,
    folder: true,
    render: (data: Overview | { commands: CommandInfo[]; audience?: string }) =>
      "verbs" in data ? renderOverview(data) : renderCommandList(data),
  })
    .description("List available commands (--verbs: the ones a person reaches for, by what they want to do)")
    .option("--verbs", "the overview by verb instead of the whole list", false)
    .addOption(
      new Option(
        "--for <audience>",
        "only the commands of an audience: a person at a terminal, an agent of a run, a host's hook, a CI job",
      ).choices(AUDIENCES),
    )
    .action(
      action((opts: { verbs: boolean; for?: Audience }) => {
        if (opts.for) return { result: ok(describeAudience(program, opts.for)) };
        return { result: ok(opts.verbs ? describeOverview(program) : describeCommands(program)) };
      }),
    );
}
