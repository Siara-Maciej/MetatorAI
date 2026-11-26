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

/**
 * What a field commits (on Enter or when it is left), or undefined for no change: the same value,
 * or an emptied number (never sent as 0; "default" resets it). Lists and keys are `a, b`.
 */
export function fieldValue(
  definition: Pick<ResolvedOption["definition"], "kind">,
  raw: string,
  current: unknown,
): { readonly value: unknown } | undefined {
  const kind = definition.kind;
  if (kind === "number") {
    const n = raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n !== current ? { value: n } : undefined;
  }
  if (kind === "list" || kind === "keybinding") {
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const was = Array.isArray(current) ? (current as unknown[]).map(String) : [];
    return list.join("\n") === was.join("\n") ? undefined : { value: list };
  }
  return raw === String(current ?? "") ? undefined : { value: raw };
}

/** A key as the keyboard reads it: any case, `esc` is `escape`. */
const chordOf = (key: string): string =>
  key
    .trim()
    .toLowerCase()
    .split("+")
    .map((part) => (part === "esc" ? "escape" : part))
    .join("+");

/** Keys bound to two actions (`keys.*`), said on each row: `prefix+z is also keys.closePane`. */
export function keyConflicts(
  options: readonly Pick<ResolvedOption, "key" | "value" | "definition">[],
): Record<string, string[]> {
  const bound = options.flatMap((o) =>
    o.definition.kind === "keybinding" && Array.isArray(o.value)
      ? (o.value as unknown[]).map((k) => ({ option: o.key, key: String(k), chord: chordOf(String(k)) }))
      : [],
  );
  const out: Record<string, string[]> = {};
  for (const b of bound) {
    const said = bound
      .filter((other) => other.option !== b.option && other.chord === b.chord)
      .map((other) => `${b.key} is also ${other.option}`);
    if (said.length > 0) out[b.option] = [...(out[b.option] ?? []), ...said];
  }
  return out;
}
