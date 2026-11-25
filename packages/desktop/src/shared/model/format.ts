/**
 * Words and numbers as a person reads them: durations, clocks, plurals, refusals, commands, sizes.
 */
import type { IssueRef, PlanLintView, RunArtifactKind } from "../api/api.ts";

/** `src/invoice.ts:10`, `run 2026…/S2`, a note: what a backlog task points at. */
export const issueRefText = (r: IssueRef): string =>
  r.file
    ? `${r.file}${r.line ? `:${r.line}` : ""}`
    : r.run
      ? `run ${r.run}${r.step ? `/${r.step}` : ""}`
      : (r.note ?? "");
/** `3s`, `4 min`, `2 h 05`, `3 d`: how long something took or has waited. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} d`;
}
export const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toTimeString().slice(0, 8);
};
/** `2 replies`, `1 reply`, `1 task`: a count with its noun. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** The message of a refusal, with its hint; what the app says when the daemon says nothing. */
export const refusalText = (
  error: { readonly message?: string; readonly hint?: string } | undefined,
  fallback = "the daemon refused",
): string => `${error?.message ?? fallback}${error?.hint ? ` ${error.hint}` : ""}`;
/* ---------- the sidebar: what needs you, the runs, and one state that rolls up ---------- */

/**
 * A run's id short enough for a line: the date prefix dropped (`20261117-`), the rest cut at 32
 * characters. The full id and the task go on hover.
 */
export function shortRunId(runId: string): string {
  const rest = runId.replace(/^\d{8}-/, "");
  return rest.length > 32 ? `${rest.slice(0, 31)}…` : rest;
}
/** One line of a list as shown: the text and how many times it came, in a row or not. */
export interface ShownLine {
  readonly text: string;
  readonly times: number;
}
/**
 * A long list cut to what a person reads first: the same line repeated is one line with a count
 * (a loop that ran twelve times is one line `×12`), the newest `keep` are shown and the rest are
 * counted. The order is the order of each line's last time.
 */
export function compactLines(
  lines: readonly string[],
  keep = 4,
): { readonly shown: readonly ShownLine[]; readonly hidden: number } {
  const last = new Map<string, number>();
  const times = new Map<string, number>();
  lines.forEach((l, i) => {
    last.set(l, i);
    times.set(l, (times.get(l) ?? 0) + 1);
  });
  const all = [...last.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([text]) => ({ text, times: times.get(text) ?? 1 }));
  const shown = all.slice(Math.max(0, all.length - keep));
  return { shown, hidden: all.length - shown.length };
}
/**
 * Why a run stopped, as a person reads it: a command's error answered as JSON
 * (`… failed: {"ok":false,"error":{"message":…,"hint":…}}`) becomes its message and its hint;
 * the tries the workflow allows (`loop 1 of 3`, `try 2 of 3`) are said apart.
 */
export function readableReason(reason: string | undefined): {
  readonly text: string;
  readonly hint?: string | undefined;
  readonly command?: string | undefined;
  readonly tries?: string | undefined;
} {
  if (!reason) return { text: "The run recorded no reason. Its activity shows what happened last." };
  const tries = /\b(?:loop|tries|try|attempt)[^\d]{0,12}(\d+) of (\d+)/i.exec(reason);
  // The JSON of an error starts `{"`: a `{runDir}` in the command is not it.
  const brace = reason.indexOf('{"');
  let text = reason.trim();
  let hint: string | undefined;
  let command: string | undefined;
  if (brace >= 0) {
    try {
      const parsed = JSON.parse(reason.slice(brace, reason.lastIndexOf("}") + 1)) as {
        error?: { message?: string; hint?: string };
        message?: string;
        hint?: string;
      };
      const message = parsed.error?.message ?? parsed.message;
      if (message) {
        text = message;
        hint = parsed.error?.hint ?? parsed.hint;
        command = /`([^`]+)`/.exec(reason.slice(0, brace))?.[1];
      }
    } catch {
      /* not JSON: the reason as it is */
    }
  }
  return {
    text,
    ...(hint ? { hint } : {}),
    ...(command ? { command } : {}),
    ...(tries ? { tries: `${tries[1]} of ${tries[2]}` } : {}),
  };
}
/** A block of an artifact as the viewer draws it: never HTML, only text in its place. */
export interface ArtifactBlock {
  readonly kind: "heading" | "text" | "code";
  readonly text: string;
}
/**
 * An artifact as blocks a person reads: Markdown's headings and fenced code blocks apart from its
 * text (the rest stays as written, with no HTML made from an agent's words), JSON pretty-printed,
 * YAML and plain text as they are, in a code block.
 */
export function artifactBlocks(kind: RunArtifactKind, text: string): ArtifactBlock[] {
  if (kind === "json") {
    try {
      return [{ kind: "code", text: JSON.stringify(JSON.parse(text), null, 2) }];
    } catch {
      return [{ kind: "code", text }];
    }
  }
  if (kind !== "markdown") return [{ kind: "code", text }];
  const out: ArtifactBlock[] = [];
  let buffer: string[] = [];
  let fence: string[] | undefined;
  const flush = () => {
    const t = buffer.join("\n").trim();
    if (t !== "") out.push({ kind: "text", text: t });
    buffer = [];
  };
  for (const line of text.split("\n")) {
    if (fence) {
      if (/^\s*```/.test(line)) {
        out.push({ kind: "code", text: fence.join("\n") });
        fence = undefined;
      } else fence.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flush();
      fence = [];
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push({ kind: "heading", text: heading[1] ?? "" });
      continue;
    }
    buffer.push(line);
  }
  if (fence) out.push({ kind: "code", text: fence.join("\n") });
  flush();
  return out;
}
/** An artifact's size for a list: `812 B`, `4.2 KB`, `1.3 MB`; an expected one is not written yet. */
export const sizeText = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** The lint of a plan in a few words: `2 errors · 1 warning`, or that it is clean. */
export function lintSummary(lint: Pick<PlanLintView, "problems">): string {
  const errors = lint.problems.filter((p) => p.severity === "error").length;
  const warnings = lint.problems.length - errors;
  if (errors + warnings === 0) return "no problems";
  return [errors > 0 ? plural(errors, "error") : "", warnings > 0 ? plural(warnings, "warning") : ""]
    .filter((x) => x !== "")
    .join(" · ");
}
/**
 * What a card shows of a host's question (round 11): the whole command when the host shows one
 * (`command`), else the prompt; cut from its START to about two lines, with "…" when it is longer.
 * A click shows it all (`full`).
 */
export function commandText(
  q: { readonly prompt: string; readonly command?: string | undefined },
  max = 160,
): { readonly short: string; readonly full: string; readonly cut: boolean } {
  const full = (q.command ?? q.prompt).trim();
  const flat = full.replace(/\s+/g, " ");
  return flat.length <= max
    ? { short: flat, full, cut: full !== flat }
    : { short: `${flat.slice(0, max - 1).trimEnd()}…`, full, cut: true };
}
