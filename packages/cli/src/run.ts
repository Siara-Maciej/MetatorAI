import { err, ok } from "@metator/core";
import { exitCodeFor, fromUnknown, serialize, toEnvelope } from "@metator/runtime";
import { type Command, CommanderError } from "commander";
import { commandWords, metaOf } from "./command-meta.ts";
import { describeCommandFor, describeCommands } from "./commands/meta.ts";
import type { Outcome } from "./context.ts";
import { buildProgram, fromCommander, type ProgramOptions, unknownCommand } from "./program.ts";
import { renderCommandHelp, renderError } from "./render.ts";

export interface Io {
  readonly out: (text: string) => void;
}

export type RunOptions = ProgramOptions;

/** The words without the program's own options (`-C <dir>`, `--root <dir>`, `--root=<dir>`, `--json`). */
function wordsOf(argv: readonly string[]): readonly string[] {
  return argv.filter((a, i) => {
    const before = argv[i - 1];
    if (before === "-C" || before === "--root") return false;
    return a !== "-C" && a !== "--root" && !a.startsWith("--root=") && a !== "--json";
  });
}

/** No words at all, or only `--help` / `-h` (with `-C <dir>` or `--root <dir>` before it): the list of commands. */
export function asksForTheList(argv: readonly string[]): boolean {
  return wordsOf(argv).every((a) => a === "--help" || a === "-h");
}

/** `metator --version` / `-V`, as other tools spell it: the `version` command. */
function asksForTheVersion(argv: readonly string[]): boolean {
  const words = wordsOf(argv);
  return words.length === 1 && (words[0] === "--version" || words[0] === "-V");
}

/** `metator help <command...>`: the words of the command whose help is asked, else nothing. */
function helpAskedFor(argv: readonly string[]): readonly string[] | undefined {
  const [first, ...rest] = wordsOf(argv);
  if (first !== "help" || rest.length === 0 || rest.some((w) => w.startsWith("-"))) return undefined;
  return rest;
}

/** `--json` among the command's words (before a `--`): the person asked for the JSON line alone. */
export function asksForJsonOnly(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--json");
}

/** Driving adapter: argv → commander → use case → one JSON envelope line → exit code. */
export async function run(argv: readonly string[], io: Io, options: RunOptions = {}): Promise<number> {
  let outcome: Outcome | undefined;
  let ran: Command | undefined;
  const program = buildProgram(
    (o, command) => {
      outcome = o;
      ran = command;
    },
    {
      ...options,
      invoke: async (inner) => {
        let text = "{}";
        // Inner commands never ask: only the command the person typed talks to them.
        const code = await run(inner, { out: (t) => (text = t) }, { ...options, terminal: null });
        return { code, envelope: JSON.parse(text) as Record<string, unknown> };
      },
    },
  );
  // What a person reads goes to stderr; stdout keeps the one JSON line, byte for byte (`--json`: only that).
  const say = (text: string) => {
    if (!asksForJsonOnly(argv)) options.terminal?.raw(`${text}\n`);
  };
  // A person reads the text at a terminal; the JSON line is for a pipe or a script (or `--json`).
  const textOnly = options.terminal != null && options.stdoutTty === true && !asksForJsonOnly(argv);
  // `metator help run status` asks what `metator run status --help` asks.
  const helpFor = helpAskedFor(argv);
  const help = describeCommandFor(program, helpFor ? [...helpFor, "--help"] : argv);
  if (help && (!helpFor || help.name.split(" ").length === helpFor.length)) {
    say(renderCommandHelp(help));
    if (!textOnly) io.out(serialize(toEnvelope(ok(help), [])));
    return 0;
  }
  if (helpFor) outcome = { result: err(unknownCommand(program, helpFor)) };
  else
    try {
      // No command: the whole list for a script, the verbs a person reaches for at a terminal.
      // `--help` with no command asks the same thing, and is an answer too, never a usage error.
      const bare = options.terminal ? ["help", "--verbs"] : ["help"];
      const words = asksForTheList(argv)
        ? bare
        : asksForTheVersion(argv)
          ? argv.map((a) => (a === "--version" || a === "-V" ? "version" : a))
          : [...argv];
      await program.parseAsync(words, { from: "user" });
      outcome ??= { result: ok(describeCommands(program)) }; // a command group without subcommand → help
    } catch (e) {
      outcome = {
        result: err(e instanceof CommanderError ? fromCommander(e, program, argv) : fromUnknown(e)),
      };
    }
  const final = outcome as Outcome;
  if (final.hook !== undefined) {
    if (final.hook !== null) io.out(JSON.stringify(final.hook));
    return 0; // a hook never fails the host's tool call by exit code
  }
  if (final.streamed) {
    if (final.result.isErr()) console.error(renderError(final.result.error));
    return final.result.isOk() ? 0 : exitCodeFor(final.result.error);
  }
  const render = ran ? metaOf(ran).render : undefined;
  // Text only for a person at a terminal; a renderer that fails never fails the command (a gate
  // script, an agent and a pipe read the JSON line, and its exit code, only).
  let rendered = false;
  if (render && final.result.isOk() && options.terminal && !asksForJsonOnly(argv)) {
    try {
      say((render as (data: unknown) => string)(final.result.value));
      rendered = true;
    } catch {
      // The JSON line below says everything.
    }
  }
  // A failure reads as text too, whatever the command: the message and the way out (said once:
  // at a terminal the JSON line would say it again).
  if (final.result.isErr()) {
    say(renderError(final.result.error));
    rendered = true;
  }
  // A cut answer names the command's own options that narrow it (`run list --limit`).
  const narrow =
    final.next ?? (ran ? `Narrow it: \`metator ${commandWords(ran)} --help\` lists its options.` : undefined);
  const line = serialize(toEnvelope(final.result, final.warnings ?? []), undefined, narrow);
  // A command answered in text at a terminal prints only that; anything else keeps its JSON line.
  if (!(rendered && textOnly)) io.out(line);
  return final.result.isOk() ? 0 : exitCodeFor(final.result.error);
}
