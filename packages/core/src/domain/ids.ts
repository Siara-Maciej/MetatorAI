/** Ids from text and digests of plain data, shared by plans, conversations and environments. */

/** Letters that do not decompose into a base letter and a mark. */
const LETTERS: Readonly<Record<string, string>> = { ł: "l", đ: "d", ø: "o", ß: "ss", æ: "ae", œ: "oe" };

/** Lower case ASCII words joined by dashes, at most `max` characters; `fallback` when nothing is left. */
export function slug(text: string, max: number, fallback: string): string {
  const out = text
    .toLowerCase()
    .replace(/[łđøßæœ]/g, (c) => LETTERS[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return out || fallback;
}

/** A plan id from its title or task: at most 48 characters. */
export const planId = (title: string): string => slug(title, 48, "plan");

/** A canonical text of plain data (keys sorted): for digests and equality, not a file format. */
export function canonical(value: unknown): string {
  if (value === undefined) return "~";
  if (value === null || typeof value !== "object")
    return typeof value === "string" ? `"${value.replace(/["\\]/g, "\\$&")}"` : String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  return `{${entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${canonical(k)}:${canonical(v)}`)
    .join(",")}}`;
}

/** FNV-1a, 32 bits, as hex: a short stable tag (not for security). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The digest of plain data: what an approval covers. */
export const digestOf = (value: unknown): string => fnv1a(canonical(value));
