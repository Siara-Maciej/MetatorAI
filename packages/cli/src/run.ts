import { err, MetatorError, ok, type Result } from "@metator/core";
import { exitCodeFor, fromUnknown, serialize, toEnvelope } from "@metator/runtime";
import pkg from "../package.json" with { type: "json" };

export interface Io {
  readonly out: (text: string) => void;
}

interface Command {
  readonly summary: string;
  readonly execute: (args: readonly string[]) => Promise<Result<unknown, MetatorError>>;
}

const commands: Readonly<Record<string, Command>> = {
  version: {
    summary: "Print the MetatorAI version",
    execute: async () => ok({ name: "metator-ai", version: pkg.version }),
  },
  help: {
    summary: "List available commands",
    execute: async () =>
      ok({ commands: Object.entries(commands).map(([name, c]) => ({ name, summary: c.summary })) }),
  },
};

/** Driving adapter: argv → command → JSON envelope on stdout → exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const [name = "help", ...args] = argv;
  const command = commands[name];
  let result: Result<unknown, MetatorError>;
  try {
    result = command
      ? await command.execute(args)
      : err(MetatorError.usage(`Unknown command: ${name}`, "Run `metator help` to list commands."));
  } catch (e) {
    result = err(fromUnknown(e));
  }
  io.out(serialize(toEnvelope(result)));
  return result.ok ? 0 : exitCodeFor(result.error);
}
