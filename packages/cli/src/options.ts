import { err, MetatorError, ok, type Result } from "@metator/core";
import { InvalidArgumentError, Option } from "commander";

/**
 * One name per meaning across the CLI (B12): a list of files is `--files`, a time limit in
 * milliseconds is `--timeout`. The spellings on the left are never a visible option of a command;
 * where one existed it stays as a hidden alias (`renamedOption`), so old command lines still work.
 */
export const FLAG_NAMES: Readonly<Record<string, string>> = {
  "--paths": "--files",
  "--timeout-ms": "--timeout",
};

/** The old spelling of a flag: parsed as before, absent from the help and the reference. */
export function renamedOption(flags: string, now: string): Option {
  return new Option(flags, `the old name of ${now}`).hideHelp();
}

/** Commander argParser for counts and budgets (MT-CODE-004: validate with commander). */
export function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("expected a positive integer");
  return n;
}

/** Commander argParser for a number where 0 has a meaning of its own (a free port, "never"). */
export function nonNegativeInt(value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isInteger(n) || n < 0)
    throw new InvalidArgumentError("expected an integer, 0 or more");
  return n;
}

/** Commander argParser for a ratio in (0, 1], e.g. a similarity threshold. */
export function ratio(value: string): number {
  const n = Number(value);
  if (!(n > 0 && n <= 1)) throw new InvalidArgumentError("expected a number in (0, 1]");
  return n;
}

/** `--run <id>`: the run a command is about; one spelling and one sentence across the CLI. */
export function runOption(description = "run id (default: latest)"): Option {
  return new Option("--run <id>", description);
}

/**
 * The run as a word after the command (`metator run status <run>`), beside `--run <id>`: every
 * other thing is named that way (`issue show <id>`). Both given and different is a usage error.
 */
export const RUN_ARGUMENT = ["[run]", "run id, the same as --run (default: latest)"] as const;
export function runGiven(
  word: string | undefined,
  opts: { readonly run?: string | undefined },
): Result<string | undefined, MetatorError> {
  if (word && opts.run && word !== opts.run)
    return err(
      MetatorError.usage(`two runs named: ${word} and --run ${opts.run}`, "Name the run once, either way."),
    );
  return ok(word || opts.run || undefined);
}

/** `--base <ref>`: the git ref a change is measured against; each command says what it compares. */
export function baseOption(description: string, fallback?: string): Option {
  const option = new Option("--base <ref>", description);
  return fallback === undefined ? option : option.default(fallback);
}

/** What a `--by` that may be left out says of its default, in the option's description. */
export const BY_DEFAULT = " (default: $METATOR_USER, else git's user.name, else your login name)";

/**
 * `--by <name>`: who acts. Left out, the name is the person's own (`who`); an approval keeps it
 * required, so a decision is never recorded under a name nobody typed.
 */
export function byOption(what: string, mode: "default" | "required" | "explicit" = "default"): Option {
  if (mode === "required") return new Option("--by <name>", what).makeOptionMandatory();
  // "explicit": the command itself says when the name must be typed (`run advance approve`).
  return new Option("--by <name>", mode === "explicit" ? what : `${what}${BY_DEFAULT}`);
}

/**
 * The fields that were given: an option left out (undefined) or given empty is dropped, so a use
 * case's optional input is absent instead of undefined.
 */
export function defined<T extends Record<string, unknown>>(
  fields: T,
): { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== "")) as never;
}
