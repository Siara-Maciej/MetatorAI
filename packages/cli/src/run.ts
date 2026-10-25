import { err, ok } from "@metator/core";
import { exitCodeFor, fromUnknown, serialize, toEnvelope } from "@metator/runtime";
import { CommanderError } from "commander";
import { describeCommands } from "./commands/meta.ts";
import type { Outcome } from "./context.ts";
import { buildProgram, fromCommander, type ProgramOptions } from "./program.ts";

export interface Io {
  readonly out: (text: string) => void;
}

export type RunOptions = ProgramOptions;

/** Driving adapter: argv → commander → use case → one JSON envelope line → exit code. */
export async function run(argv: readonly string[], io: Io, options: RunOptions = {}): Promise<number> {
  let outcome: Outcome | undefined;
  const program = buildProgram((o) => {
    outcome = o;
  }, options);
  try {
    await program.parseAsync(argv.length === 0 ? ["help"] : [...argv], { from: "user" });
    outcome ??= { result: ok(describeCommands(program)) }; // a command group without subcommand → help
  } catch (e) {
    outcome = { result: err(e instanceof CommanderError ? fromCommander(e, program) : fromUnknown(e)) };
  }
  const final = outcome as Outcome;
  io.out(serialize(toEnvelope(final.result, final.warnings ?? [])));
  return final.result.isOk() ? 0 : exitCodeFor(final.result.error);
}
