import type { Command } from "commander";

/** Who a command is for: a person at a terminal, an agent of a run, a host's hook, a CI job. */
export const AUDIENCES = ["person", "agent", "hook", "ci"] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * What a command says of itself where it is registered (`meta(cmd, {...})`), so nothing about it
 * lives in a list in another file: the MCP tools, the commands a folder of repositories runs,
 * `meta check-all`, `help --for` and the text a person reads all come from here.
 */
export interface CommandMeta {
  /** Who reaches for it; a command that says nothing is an agent's (`help --for`). */
  readonly audience?: Audience;
  /** It only reads and prints: an MCP tool. On a group, every command of the group. */
  readonly reads?: boolean;
  /** Options of a reading command that write, send or run something: an MCP tool call refuses them. */
  readonly writesWith?: readonly string[];
  /** Options an MCP tool always passes, so the command leaves no trace. */
  readonly readsWith?: readonly string[];
  /** It runs in a folder of repositories and covers all of them. */
  readonly folder?: boolean;
  /** `meta check-all` runs it, with these options. */
  readonly check?: readonly string[];
  /** The command's data as a person reads it; written to stderr at a terminal (stdout keeps the JSON). */
  readonly render?: (data: never) => string;
  /** This is the old spelling, hidden from the help: the words of the command it is now. */
  readonly renamedTo?: string;
  /** This command had another spelling, which still runs: its words. */
  readonly renamedFrom?: string;
}

const metas = new WeakMap<Command, CommandMeta>();

/** Says what the command is; returns it, so the registration chain goes on. */
export function meta<C extends Command>(cmd: C, said: CommandMeta): C {
  metas.set(cmd, { ...metas.get(cmd), ...said });
  return cmd;
}

export const metaOf = (cmd: Command): CommandMeta => metas.get(cmd) ?? {};

/** The command's words (`run status`), without the program's name. */
export function commandWords(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c?.parent; c = c.parent) parts.unshift(c.name());
  return parts.join(" ");
}

/** Whether the command only reads: it says so, or a group above it does. */
export function reads(cmd: Command): boolean {
  for (let c: Command | null = cmd; c; c = c.parent) if (metaOf(c).reads) return true;
  return false;
}

export interface Tagged {
  readonly name: string;
  readonly cmd: Command;
  readonly meta: CommandMeta;
}

/** Every command and group of the tree with its words, in the tree's order (old spellings too). */
export function everyCommand(program: Command): Tagged[] {
  const out: Tagged[] = [];
  const walk = (cmd: Command, prefix: string) => {
    for (const sub of cmd.commands) {
      const name = `${prefix}${sub.name()}`;
      out.push({ name, cmd: sub, meta: metaOf(sub) });
      walk(sub, `${name} `);
    }
  };
  walk(program, "");
  return out;
}

/** The commands a folder of repositories runs (G2, ADR-0057). */
export const folderCommands = (program: Command): string[] =>
  everyCommand(program)
    .filter((c) => c.meta.folder)
    .map((c) => c.name);

/** What `meta check-all` runs: each command that says `check`, with its options, in the tree's order. */
export const checkCommands = (program: Command): string[][] =>
  everyCommand(program)
    .filter((c) => c.meta.check && !c.meta.renamedFrom)
    .map((c) => [...c.name.split(" "), ...(c.meta.check ?? [])]);

/**
 * The commands of an audience: the ones that name it, and for `agent` the ones that name none.
 * `ci` also takes every command `meta check-all` runs, whoever else reaches for it.
 */
export function commandsFor(program: Command, audience: Audience): string[] {
  return everyCommand(program)
    .filter((c) => !c.meta.renamedTo)
    .filter((c) => {
      if (audience === "ci" && c.meta.check) return true;
      if (c.meta.audience) return c.meta.audience === audience;
      // A group that says nothing is not a command of its own; a leaf that says nothing is an agent's.
      return audience === "agent" && c.cmd.commands.length === 0;
    })
    .map((c) => c.name);
}

/**
 * The same command under its old words: `build` registers both, so they take the same arguments
 * and options and do the same thing. The old spelling still parses and is left out of the help,
 * as a renamed flag is (`renamedOption`).
 */
export function renamedCommand(
  old: { readonly parent: Command; readonly name: string },
  now: { readonly parent: Command; readonly name: string },
  build: (cmd: Command) => unknown,
): Command {
  const current = now.parent.command(now.name);
  build(current);
  const before = old.parent.command(old.name, { hidden: true });
  build(before);
  meta(before, { renamedTo: commandWords(current) });
  meta(current, { renamedFrom: commandWords(before) });
  return current;
}
