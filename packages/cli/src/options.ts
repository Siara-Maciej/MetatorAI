import { InvalidArgumentError } from "commander";

/** Commander argParser for counts and budgets (MT-CODE-004: validate with commander). */
export function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("expected a positive integer");
  return n;
}

/** Commander argParser for a ratio in (0, 1], e.g. a similarity threshold. */
export function ratio(value: string): number {
  const n = Number(value);
  if (!(n > 0 && n <= 1)) throw new InvalidArgumentError("expected a number in (0, 1]");
  return n;
}
