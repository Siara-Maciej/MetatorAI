/**
 * The conversation agent's first stage, as the app sees it (pure, tested; round 13): which agent
 * the "+ New run" chat opens, the quick cards' one special option, a commit or push that needs
 * the person's consent, and the debug changes (scratch) with what removing them did.
 */

/** The agent of the chat when the repository has no conversation agent (an older setup). */
export const OLD_CHAT_AGENT = "mt-orchestrator";

/**
 * The agent the "+ New run" chat opens: the repository's conversation agent when the daemon names
 * one (`/supervisor` `chatAgent`, `mt-chat`), else the agent that started runs before.
 */
export const chatAgentOf = (supervisor: object | undefined): string => {
  const named = (supervisor as { chatAgent?: unknown } | undefined)?.chatAgent;
  return typeof named === "string" && named.trim() !== "" ? named : OLD_CHAT_AGENT;
};

/** The quick card's option that is no answer: it opens the run's change, and the card stays. */
export const OPEN_DIFF = "Open diff";
export const opensDiff = (choices: readonly string[]): boolean =>
  choices.length === 1 && choices[0] === OPEN_DIFF;

/** The git commands that run only with the person's consent (`guard.commands.ask`). */
export type ConsentKind = "commit" | "push" | "merge" | "rebase";

/**
 * A host's question that is a commit, push, merge or rebase waiting for the person's consent: the
 * kind, from the command the host shows (else the prompt's start). Anything else is undefined: a
 * plain permission prompt.
 */
export function consentOf(q: {
  readonly prompt: string;
  readonly command?: string | undefined;
}): { readonly kind: ConsentKind; readonly text: string } | undefined {
  const command = (q.command ?? q.prompt).trim();
  // `git commit …`, also after `cd x &&`, with `-C <dir>` or `-c key=value` before the verb.
  const m = /(?:^|[\s;&|(])git(?:\s+-[cC]\s+\S+)*\s+(commit|push|merge|rebase)(?=\s|$)/.exec(command);
  if (!m) return undefined;
  const kind = m[1] as ConsentKind;
  return {
    kind,
    text: `git ${kind} needs your consent: it runs only when you say Yes here, or ask for it in the chat. MetatorAI never does it by itself.`,
  };
}

/** One recorded debug change (`GET /scratch`): the files it touched, what it was for, when. */
export interface ScratchItem {
  readonly id: string;
  readonly repo?: string | undefined;
  readonly files: readonly string[];
  readonly note?: string | undefined;
  readonly at: string;
}

/** What `GET /scratch` answered, as items: `files` or one `file`; anything else is left out. */
export function scratchItems(data: unknown, repo?: string): ScratchItem[] {
  const raw = (data as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): ScratchItem[] => {
    const i = x as { id?: unknown; files?: unknown; file?: unknown; note?: unknown; at?: unknown };
    if (typeof i.id !== "string") return [];
    const files = Array.isArray(i.files)
      ? i.files.filter((f): f is string => typeof f === "string")
      : typeof i.file === "string"
        ? [i.file]
        : [];
    return [
      {
        id: i.id,
        ...(repo ? { repo } : {}),
        files,
        ...(typeof i.note === "string" && i.note.trim() !== "" ? { note: i.note } : {}),
        at: typeof i.at === "string" ? i.at : "",
      },
    ];
  });
}

/** How many debug changes the daemon's state counts: the repository's, or the folder's repositories'. */
export function scratchCount(state: unknown, repos?: readonly (string | undefined)[]): number {
  const s = state as
    | { scratch?: unknown; repos?: readonly { name?: string; scratch?: unknown }[] }
    | undefined;
  if (!s) return 0;
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? Math.floor(v) : 0);
  if (!Array.isArray(s.repos)) return n(s.scratch);
  return s.repos.filter((r) => !repos || repos.includes(r.name)).reduce((sum, r) => sum + n(r.scratch), 0);
}

/** The repositories whose scratch the state counts (a folder), or the daemon's own (`undefined`). */
export function scratchRepos(
  state: unknown,
  repos?: readonly (string | undefined)[],
): (string | undefined)[] {
  const s = state as
    | { scratch?: unknown; repos?: readonly { name?: string; scratch?: unknown }[] }
    | undefined;
  if (!s) return [];
  if (!Array.isArray(s.repos)) return typeof s.scratch === "number" && s.scratch > 0 ? [undefined] : [];
  return s.repos
    .filter((r) => typeof r.scratch === "number" && r.scratch > 0 && (!repos || repos.includes(r.name)))
    .map((r) => r.name);
}

/** One debug change in a line: its files, what it was for. */
export const scratchLine = (i: ScratchItem): string =>
  [
    i.files.length === 0
      ? "no file"
      : i.files.length <= 3
        ? i.files.join(", ")
        : `${i.files.slice(0, 3).join(", ")} and ${i.files.length - 3} more`,
    i.note,
  ]
    .filter((x) => x !== undefined)
    .join(" · ");

/** What `POST /scratch/drop` did. */
export interface ScratchDropped {
  readonly dropped?: readonly { readonly id: string; readonly files?: readonly string[] }[];
  readonly failed?: readonly {
    readonly id: string;
    readonly files?: readonly string[];
    readonly why: string;
  }[];
}

/** What removing debug changes did, in one line: what was removed, and what could not be and why. */
export function dropText(results: readonly ScratchDropped[]): {
  readonly text: string;
  readonly ok: boolean;
} {
  const dropped = results.flatMap((r) => r.dropped ?? []);
  const failed = results.flatMap((r) => r.failed ?? []);
  const n = (k: number) => `${k} debug change${k === 1 ? "" : "s"}`;
  const files = [...new Set(dropped.flatMap((d) => d.files ?? []))];
  const head =
    dropped.length > 0
      ? `Removed ${n(dropped.length)}${files.length > 0 ? ` (${files.join(", ")})` : ""}.`
      : "Nothing was removed.";
  if (failed.length === 0) return { text: head, ok: true };
  return {
    text: `${head} ${n(failed.length)} could not be removed: ${failed
      .map((f) => `${(f.files ?? []).join(", ") || f.id} (${f.why})`)
      .join("; ")}. Nothing was forced: undo ${failed.length === 1 ? "it" : "them"} by hand.`,
    ok: false,
  };
}
