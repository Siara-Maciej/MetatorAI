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
