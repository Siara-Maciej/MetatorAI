/**
 * Which options Settings shows (pure, tested): the section's, or the search's matches, as keys a
 * row reads its own option by; and the key conflicts of the whole list, worked out once per list.
 */
import type { ResolvedOption } from "../../shared/api/api.ts";
import { keyConflicts, optionMatches } from "./model.ts";

/** The keys shown: the search's matches when there is one, else the section's options. */
export const shownKeys = (
  options: readonly ResolvedOption[],
  section: string,
  query: string,
): readonly string[] =>
  (query.trim() !== ""
    ? options.filter((o) => optionMatches(o, query))
    : options.filter((o) => o.key.startsWith(`${section}.`))
  ).map((o) => o.key);

const conflicts = new WeakMap<readonly ResolvedOption[], Readonly<Record<string, readonly string[]>>>();

/** The key conflicts of a list of options: the same answer (the same object) for the same list. */
export function conflictsOf(options: readonly ResolvedOption[]): Readonly<Record<string, readonly string[]>> {
  const known = conflicts.get(options);
  if (known) return known;
  const made = keyConflicts(options);
  conflicts.set(options, made);
  return made;
}
