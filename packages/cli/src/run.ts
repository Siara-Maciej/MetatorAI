import { err, ok } from "@metator/core";
import { exitCodeFor, fromUnknown, serialize, toEnvelope } from "@metator/runtime";
import { CommanderError } from "commander";
import { describeCommandFor, describeCommands } from "./commands/meta.ts";
import type { Outcome } from "./context.ts";
import { buildProgram, fromCommander, type ProgramOptions } from "./program.ts";

export interface Io {
  readonly out: (text: string) => void;
}

export type RunOptions = ProgramOptions;

/** No words at all, or only `--help` / `-h` (with `-C <dir>` or `--root <dir>` before it): the list of commands. */
export function asksForTheList(argv: readonly string[]): boolean {
  const words = argv.filter((a, i) => {
    const before = argv[i - 1];
    if (before === "-C" || before === "--root") return false;
    return a !== "-C" && a !== "--root" && !a.startsWith("--root=");
  });
  return words.every((a) => a === "--help" || a === "-h");
}

/** Driving adapter: argv → commander → use case → one JSON envelope line → exit code. */
export async function run(argv: readonly string[], io: Io, options: RunOptions = {}): Promise<number> {
  let outcome: Outcome | undefined;
  const program = buildProgram(
    (o) => {
      outcome = o;
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
  const help = describeCommandFor(program, argv);
  if (help) {
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
  io.out(serialize(toEnvelope(final.result, final.warnings ?? [])));
  return final.result.isOk() ? 0 : exitCodeFor(final.result.error);
}
