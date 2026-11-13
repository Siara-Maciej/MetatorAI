import { err, ok } from "@metator/core";
import { exitCodeFor, fromUnknown, serialize, toEnvelope } from "@metator/runtime";
import { type Command, CommanderError } from "commander";
import { metaOf } from "./command-meta.ts";
import { describeCommandFor, describeCommands } from "./commands/meta.ts";
import type { Outcome } from "./context.ts";
import { buildProgram, fromCommander, type ProgramOptions } from "./program.ts";
import { renderCommandHelp } from "./render.ts";

export interface Io {
  readonly out: (text: string) => void;
}

export type RunOptions = ProgramOptions;

/** No words at all, or only `--help` / `-h` (with `-C <dir>` or `--root <dir>` before it): the list of commands. */
export function asksForTheList(argv: readonly string[]): boolean {
  const words = argv.filter((a, i) => {
    const before = argv[i - 1];
    if (before === "-C" || before === "--root") return false;
    return a !== "-C" && a !== "--root" && !a.startsWith("--root=") && a !== "--json";
  });
  return words.every((a) => a === "--help" || a === "-h");
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
  const help = describeCommandFor(program, argv);
  if (help) {
    say(renderCommandHelp(help));
    io.out(serialize(toEnvelope(ok(help), [])));
    return 0;
  }
  try {
    // No command: the whole list for a script, the verbs a person reaches for at a terminal.
    // `--help` with no command asks the same thing, and is an answer too, never a usage error.
    const bare = options.terminal ? ["help", "--verbs"] : ["help"];
    await program.parseAsync(asksForTheList(argv) ? bare : [...argv], { from: "user" });
    outcome ??= { result: ok(describeCommands(program)) }; // a command group without subcommand → help
  } catch (e) {
    outcome = { result: err(e instanceof CommanderError ? fromCommander(e, program) : fromUnknown(e)) };
  }
  const final = outcome as Outcome;
  if (final.hook !== undefined) {
    if (final.hook !== null) io.out(JSON.stringify(final.hook));
    return 0; // a hook never fails the host's tool call by exit code
  }
  const render = ran ? metaOf(ran).render : undefined;
  if (render && final.result.isOk()) say((render as (data: unknown) => string)(final.result.value));
  io.out(serialize(toEnvelope(final.result, final.warnings ?? [])));
  return final.result.isOk() ? 0 : exitCodeFor(final.result.error);
}
