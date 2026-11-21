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

/** What every host approval says: no reason worth a line of its own. */
const PLAIN_WHY = "This command requires approval";

/**
 * Why a host asks, when it says more than that the command needs approval (the guard's reason:
 * "this commit holds debug changes: src/price.ts. …"): the part of the prompt after the command
 * (`<first line of the command> — <why>`). A card whose heading is the command shows it under it.
 */
export function askWhy(q: {
  readonly prompt: string;
  readonly command?: string | undefined;
}): string | undefined {
  if (!q.command) return undefined;
  const at = q.prompt.lastIndexOf(" — ");
  const why = at >= 0 ? q.prompt.slice(at + 3).trim() : "";
  return why === "" || why === PLAIN_WHY ? undefined : why;
}

/**
 * One recorded debug change (`GET /scratch`): the files that hold it, what it was for, when. A
 * `changed` one can no longer be taken out as recorded (its lines, or the ones around them,
 * changed since): it stays, with why, until the person takes it out by hand or forgets it.
 */
export interface ScratchItem {
  readonly id: string;
  readonly repo?: string | undefined;
  readonly files: readonly string[];
  readonly note?: string | undefined;
  readonly at: string;
  readonly state: "removable" | "changed";
  readonly why?: string | undefined;
}

/** A record that left because no file holds its lines any more: said once, by the answer that removed it. */
export interface ScratchGone {
  readonly id: string;
  readonly files?: readonly string[];
  readonly why: string;
}

/** What `GET /scratch` answered, as items: `files` or one `file`; anything else is left out. */
export function scratchItems(data: unknown, repo?: string): ScratchItem[] {
  const raw = (data as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): ScratchItem[] => {
    const i = x as {
      id?: unknown;
      files?: unknown;
      file?: unknown;
      note?: unknown;
      at?: unknown;
      state?: unknown;
      why?: unknown;
    };
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
        state: i.state === "changed" ? "changed" : "removable",
        ...(typeof i.why === "string" && i.why.trim() !== "" ? { why: i.why } : {}),
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

/** The records an answer says are gone (`gone` of `GET /scratch` and of a drop). */
export function scratchGone(data: unknown): ScratchGone[] {
  const raw = (data as { gone?: unknown } | undefined)?.gone;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): ScratchGone[] => {
    const g = x as { id?: unknown; files?: unknown; why?: unknown };
    if (typeof g.id !== "string") return [];
    const files = Array.isArray(g.files) ? g.files.filter((f): f is string => typeof f === "string") : [];
    return [{ id: g.id, files, why: typeof g.why === "string" && g.why !== "" ? g.why : `${g.id} is gone` }];
  });
}

/** What the daemon says of records that are gone, as sentences: `s002 is gone: src/tax.ts no longer holds it.` */
export const goneText = (gone: readonly ScratchGone[]): string =>
  gone.map((g) => `${g.why.replace(/\.$/, "")}.`).join(" ");

/**
 * Why a changed record cannot be taken out, without the daemon's hint for a terminal (the app
 * has its own: Forget): the first sentence of its `why`.
 */
export const changedWhy = (why: string | undefined): string => {
  const first = (why ?? "").split(/\.\s+(?=[A-Z])/)[0]?.trim() ?? "";
  return first === "" ? "its lines changed since it was recorded" : first.replace(/\.$/, "");
};

/** What `POST /scratch/drop` did. */
export interface ScratchDropped {
  readonly dropped?: readonly { readonly id: string; readonly files?: readonly string[] }[];
  readonly failed?: readonly {
    readonly id: string;
    readonly files?: readonly string[];
    readonly why: string;
  }[];
  readonly gone?: readonly ScratchGone[];
}

/**
 * What removing debug changes did, in one line: what was removed, what is gone because no file
 * holds it any more, and what could not be removed, why, and that it stays in the list.
 */
export function dropText(results: readonly ScratchDropped[]): {
  readonly text: string;
  readonly ok: boolean;
} {
  const dropped = results.flatMap((r) => r.dropped ?? []);
  const failed = results.flatMap((r) => r.failed ?? []);
  const gone = results.flatMap((r) => scratchGone(r));
  const n = (k: number) => `${k} debug change${k === 1 ? "" : "s"}`;
  const files = [...new Set(dropped.flatMap((d) => d.files ?? []))];
  const head =
    dropped.length > 0
      ? `Removed ${n(dropped.length)}${files.length > 0 ? ` (${files.join(", ")})` : ""}.`
      : gone.length > 0
        ? undefined
        : "Nothing was removed.";
  const said = [head, gone.length > 0 ? goneText(gone) : undefined].filter((x) => x !== undefined);
  if (failed.length === 0) return { text: said.join(" "), ok: true };
  return {
    text: `${said.join(" ")} ${n(failed.length)} could not be removed: ${failed
      .map((f) => changedWhy(f.why))
      .join("; ")}. Nothing was forced: ${failed.length === 1 ? "it stays" : "they stay"} in the list; take ${
      failed.length === 1 ? "its" : "their"
    } lines out by hand, or forget ${failed.length === 1 ? "it" : "them"}.`,
    ok: false,
  };
}

/** What `POST /scratch/forget` did: the records are dismissed, no file was touched. */
export function forgetText(result: {
  readonly forgotten?: readonly { readonly id: string; readonly files?: readonly string[] }[];
}): string {
  const forgotten = result.forgotten ?? [];
  if (forgotten.length === 0) return "Nothing was forgotten.";
  const files = [...new Set(forgotten.flatMap((f) => f.files ?? []))];
  return `Forgot ${forgotten.length} debug change${forgotten.length === 1 ? "" : "s"}${
    files.length > 0 ? ` (${files.join(", ")})` : ""
  }: ${forgotten.length === 1 ? "its" : "their"} lines stay in your files.`;
}
