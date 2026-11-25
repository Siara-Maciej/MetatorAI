/**
 * The options screen: which options a filter shows.
 */
import type { ResolvedOption } from "../../shared/api/api.ts";

/** The settings search: the key, the title or the description holds the words. */
export const optionMatches = (o: ResolvedOption, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return (
    q === "" ||
    o.key.toLowerCase().includes(q) ||
    o.definition.title.toLowerCase().includes(q) ||
    o.definition.description.toLowerCase().includes(q)
  );
};
