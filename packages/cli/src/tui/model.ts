import type { Attention, ConversationOverview, Overview, RunOverview, StageProgress } from "@metator/core";

/**
 * What `metator ui` shows (G5, ADR-0060): the overview of each repository (one in a repository,
 * several in a folder of repositories), turned into the rows of the session list.
 */
export interface RepoWork {
  readonly name: string;
  /** Absolute path; actions on its sessions go to this repository. */
  readonly root: string;
  readonly overview?: Overview;
  readonly error?: string;
}

export interface Snapshot {
  /** The repository's or the folder's name. */
  readonly title: string;
  readonly repos: readonly RepoWork[];
  /** In a folder: the conversations asked in the folder itself. */
  readonly folderConversations?: readonly ConversationOverview[];
  /** Where a new folder-wide question is asked (the folder), when there is a folder. */
  readonly folderRoot?: string;
}

export type Row =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "run"; readonly key: string; readonly repo: string; readonly run: RunOverview }
  | {
      readonly kind: "chat";
      readonly key: string;
      readonly repo: string;
      readonly chat: ConversationOverview;
    };

/** The list: runs by repository (who must act first), then the conversations. */
export function rowsOf(s: Snapshot): Row[] {
  const rows: Row[] = [];
  const many = s.repos.length > 1;
  for (const r of s.repos) {
    if (many) rows.push({ kind: "heading", text: r.error ? `${r.name} · ${r.error}` : r.name });
    for (const run of r.overview?.runs ?? [])
      rows.push({ kind: "run", key: `${r.root}#${run.runId}`, repo: r.root, run });
  }
  const chats: Row[] = [];
  for (const r of s.repos)
    for (const chat of r.overview?.conversations ?? [])
      chats.push({ kind: "chat", key: `${r.root}~${chat.id}`, repo: r.root, chat });
  for (const chat of s.folderConversations ?? [])
    chats.push({ kind: "chat", key: `${s.folderRoot}~${chat.id}`, repo: s.folderRoot ?? "", chat });
  if (chats.length > 0) rows.push({ kind: "heading", text: "Conversations" }, ...chats);
  return rows;
}

export const selectable = (rows: readonly Row[]) => rows.filter((r) => r.kind !== "heading");

export interface Totals {
  readonly you: number;
  readonly driving: number;
  readonly stopped: number;
  readonly escalated: number;
  readonly questions: number;
  readonly services: number;
}

export function totals(s: Snapshot): Totals {
  const sum = (k: keyof Totals) => s.repos.reduce((n, r) => n + (r.overview?.counts[k] ?? 0), 0);
  return {
    you: sum("you"),
    driving: sum("driving"),
    stopped: sum("stopped"),
    escalated: sum("escalated"),
    questions: sum("questions"),
    services: sum("services"),
  };
}

export const ATTENTION: Readonly<
  Record<Attention, { readonly icon: string; readonly label: string; readonly color: string }>
> = {
  you: { icon: "?", label: "needs you", color: "yellow" },
  driving: { icon: "⟳", label: "driving", color: "cyan" },
  stopped: { icon: "‖", label: "stopped", color: "gray" },
  done: { icon: "✓", label: "done", color: "green" },
  escalated: { icon: "!", label: "escalated", color: "red" },
  aborted: { icon: "✗", label: "aborted", color: "red" },
};

const STAGE_MARK: Readonly<Record<StageProgress["state"], string>> = {
  done: "✓",
  current: "⟳",
  waiting: "?",
  next: "·",
  stopped: "!",
};

/** `intake ✓ ─ plan ✓ ─ [plan-approval ?] ─ build ·`: the current stage in brackets. */
export function stageBar(stages: readonly StageProgress[]): string {
  return stages
    .map((s) => {
      const label = `${s.id} ${STAGE_MARK[s.state]}`;
      return s.state === "current" || s.state === "waiting" || s.state === "stopped" ? `[${label}]` : label;
    })
    .join(" ─ ");
}

/** `45 s`, `12 min`, `3 h 05 min`, `2 d 4 h`. */
export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** One line on what the run needs now, and the key that does it. */
export function nextStep(run: RunOverview): string {
  const q = run.questions[0];
  if (q) return `waits for you: ${q.prompt}  (a: answer)`;
  if (run.attention === "you") return `waits at ${run.stage}: approve it (a) or continue the run (c)`;
  if (run.attention === "driving") return `working${run.last ? `: ${run.last.text}` : ""}`;
  if (run.attention === "stopped") return `stopped at ${run.stage}  (c: continue)`;
  if (run.attention === "escalated") return `at ${run.stage}: fix the cause, then resume it (c)`;
  if (run.attention === "aborted") return `at ${run.stage}`;
  return "every stage passed";
}

/** The text cut to a width, with an ellipsis. */
export function fit(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width));
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/** How many terminal lines a text takes at a width, wrapped as Ink wraps it (roughly, by length). */
export function wrappedLines(text: string, width: number): number {
  const w = Math.max(1, width);
  return text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / w)), 0);
}

/** The farthest a view of `lines` lines scrolls in a window of `rows` lines. */
export const maxScroll = (lines: number, rows: number) => Math.max(0, lines - rows);
