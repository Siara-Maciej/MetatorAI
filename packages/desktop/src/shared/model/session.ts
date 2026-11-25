/**
 * What this window remembers of the person: the runs they have seen, and when the app starts the daemon itself.
 */

/** When this person last opened each run, by `<repo>/<run>`: kept in the window's storage. */
export type SeenRuns = Readonly<Record<string, string>>;
export const seenKey = (run: { readonly runId: string; readonly repo?: string | undefined }): string =>
  `${run.repo ?? ""}/${run.runId}`;
/** The stored text as the map; anything that is not such a map is no map. */
export function seenFrom(text: string | null): SeenRuns {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}
/** The map with a run opened now; only the newest `keep` entries stay, so it never grows without end. */
export function withSeen(seen: SeenRuns, key: string, at: string, keep = 200): SeenRuns {
  const entries = Object.entries({ ...seen, [key]: at }).sort((a, b) => b[1].localeCompare(a[1]));
  return Object.fromEntries(entries.slice(0, keep));
}
/**
 * Whether the app starts the daemon itself now (ADR-0101): only in its shell, only while nothing
 * answers, once per folder until the person asks again; without a remembered folder it asks.
 */
export function autostart(a: {
  readonly shell: boolean;
  readonly down: boolean;
  readonly folder: string | undefined;
  /** The folder the last start was for, while the daemon has not answered since. */
  readonly tried: string | undefined;
  readonly starting: boolean;
}): "start" | "ask" | "none" {
  if (!a.shell || !a.down || a.starting) return "none";
  const folder = a.folder?.trim() ?? "";
  if (folder === "") return "ask";
  return a.tried === folder ? "none" : "start";
}
