import { InvalidArgumentError } from "commander";

/** Commander argParser for counts and budgets (MT-CODE-004: validate with commander). */
export function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("expected a positive integer");
  return n;
}
