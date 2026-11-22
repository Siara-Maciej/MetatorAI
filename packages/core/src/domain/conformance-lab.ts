import type { ConformanceExpectation, ConformanceSession } from "./host-conformance.ts";

/**
 * What the conformance suite does to and sees of its throwaway repository (the `ConformanceLab`
 * port's words), and how a check judges what it sees: pure, so every verdict is tested without a
 * daemon or a host.
 */

/** A pane as the suite sees it: alive or paused, what its agent does, its host session id. */
export interface LabPane {
  readonly id: string;
  readonly alive: boolean;
  /** Why it is paused (its process went with the daemon), when it is. */
  readonly paused?: string;
  /** The pane sensor's state (`idle`, `working`, `blocked`, …) and why. */
  readonly state?: string;
  readonly reason?: string;
  /** The host's id of the session in the pane (`continue` for a host that names its sessions itself). */
  readonly sessionId?: string;
  /** The last call of one of its session's hooks. */
  readonly lastHookAt?: string;
}

/** An open question of the pane in the inbox (ADR-0091). */
export interface LabQuestion {
  readonly id: string;
  readonly source: "agent" | "permission";
  readonly prompt: string;
  readonly command?: string;
  /** The guard's reason, when the host asks because the guard did. */
  readonly reason?: string;
  readonly options: readonly string[];
}

/** One record the pre-tool guard kept for the pane (`GuardAsked`): never the command, only why. */
export interface LabGuardRecord {
  readonly at: string;
  readonly decision: "ask" | "deny";
  readonly reason: string;
}

/** Everything a check looks at, read at one moment. */
export interface LabView {
  readonly pane?: LabPane;
  /** The pane's rendered screen (scrollback, then the screen), as a person reads it. */
  readonly screen: string;
  readonly questions: readonly LabQuestion[];
  readonly guard: readonly LabGuardRecord[];
  /** The pane's consents file: when it was last written, and the kinds it still holds. */
  readonly consents: { readonly writtenAt?: string; readonly kinds: readonly string[] };
  readonly git: { readonly commits: number; readonly subject: string };
  /** The files asked for, by repo-relative path; undefined when missing. */
  readonly files: Readonly<Record<string, string | undefined>>;
}

/** What the suite does in its repository, as a person would. */
export type LabAction =
  /** Opens a session: the chat as a new thread (with this title), or a run's session (told `prompt`). */
  | {
      readonly kind: "session";
      readonly session: ConformanceSession;
      readonly title?: string;
      readonly prompt?: string;
    }
  /** Types words into the pane through its terminal, as a person at the keyboard; `enter` sends them. */
  | { readonly kind: "type"; readonly pane: string; readonly text: string; readonly enter: boolean }
  /** Answers a pane question through the inbox (`POST /panes/:pane/answer`). */
  | { readonly kind: "answer"; readonly pane: string; readonly question: string; readonly choice: string }
  /** `metator session tell <pane> --text …` / `metator session interrupt <pane> --text …`. */
  | { readonly kind: "tell" | "interrupt"; readonly pane: string; readonly text: string }
  /** The daemon killed with SIGKILL (its hosts with it) and started again with `--no-restore`. */
  | { readonly kind: "restart" }
  /** A paused pane continued (`POST /panes/:pane/continue`). */
  | { readonly kind: "continue"; readonly pane: string }
  /** A file of the repository written, and staged when asked. */
  | {
      readonly kind: "write";
      readonly path: string;
      readonly text: string;
      readonly stage: boolean;
    }
  /**
   * The sandbox turned on in the repository (`metator config set sandbox.enabled true`), with a
   * file holding `text` in a directory of the repository that `sandbox.denyRead` lists; the
   * file's path, as the session names it, comes back.
   */
  | { readonly kind: "sandbox"; readonly file: string; readonly text: string };

/** The host's placeholder for a session it names itself and tells nobody (`CONTINUE_SESSION`). */
const PLACEHOLDER_SESSION = "continue";

/** The words without any whitespace: a terminal wraps long lines wherever it likes. */
const squeeze = (text: string) => text.replace(/\s+/g, "");

/**
 * The screen after the last showing of `words` (the start of what the session was last given),
 * whitespace taken out; the whole screen when they are not on it.
 */
export function screenAfter(screen: string, words: string | undefined): string {
  const flat = squeeze(screen);
  if (!words) return flat;
  // The words whole; else their end (it holds the check's own word), else their start: a host
  // may show a long message cut.
  const all = squeeze(words);
  for (const needle of [all, all.slice(-32), all.slice(0, 24)]) {
    const at = needle === "" ? -1 : flat.lastIndexOf(needle);
    if (at >= 0) return flat.slice(at + needle.length);
  }
  return flat;
}

/** The screen's line that shows `words` (whitespace aside), else its last lines: what proves it, or what was there. */
export function screenLine(screen: string, words: string): string {
  const want = squeeze(words);
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--)
    if (squeeze(lines[i] as string).includes(want)) return (lines[i] as string).trim();
  return tail(screen, 12);
}

/** The last non-empty lines of a screen, joined. */
export function tail(screen: string, lines: number): string {
  return screen
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-lines)
    .join("\n");
}

/** What a check knows when it judges: when it began, what it was given, how things stood at its start. */
export interface JudgeContext {
  /** When the check began (ISO). */
  readonly since: string;
  /** The first and the last words the session was given in this check. */
  readonly firstWords?: string;
  readonly lastWords?: string;
  /** The commits when the check began. */
  readonly commitsBefore: number;
  /** The host prompts that came up during the check (answered No by the suite). */
  readonly prompts: readonly string[];
}

export interface ConformanceVerdict {
  readonly ok: boolean;
  /** One line of evidence: what was seen that proves it, or what was there instead. */
  readonly evidence: string;
}

/**
 * How a shell, or a host's own file tool, shows the system's refusal of a read: EACCES, ENOENT (a
 * denied directory is empty in the sandbox), EPERM.
 */
export const READ_REFUSALS: readonly string[] = [
  "Permission denied",
  "No such file or directory",
  "Operation not permitted",
  "does not exist",
  "EACCES",
  "ENOENT",
];

/** Records written since the check began, with a second's slack for the clocks of two processes. */
const sinceCheck = (at: string | undefined, since: string): boolean =>
  at !== undefined && Date.parse(at) >= Date.parse(since) - 1000;

/** Whether what is seen holds an expectation (its words already filled), with the line that says so. */
export function judgeConformance(
  expected: ConformanceExpectation,
  seen: LabView,
  ctx: JudgeContext,
): ConformanceVerdict {
  if ("readRefused" in expected) {
    const after = screenAfter(seen.screen, ctx.lastWords).toLowerCase();
    const refusal = READ_REFUSALS.find((r) => after.includes(squeeze(r).toLowerCase()));
    return refusal
      ? { ok: true, evidence: `the system refused the read: ${screenLine(seen.screen, refusal)}` }
      : {
          ok: false,
          evidence: `no refusal of the read on the screen after the words given; its last lines:\n${tail(seen.screen, 12)}`,
        };
  }
  if ("screen" in expected) {
    const found = screenAfter(seen.screen, ctx.lastWords).includes(squeeze(expected.screen));
    return found
      ? { ok: true, evidence: `screen: ${screenLine(seen.screen, expected.screen)}` }
      : {
          ok: false,
          evidence: `"${expected.screen}" is not on the screen after the words given; its last lines:\n${tail(seen.screen, 12)}`,
        };
  }
  if ("absent" in expected) {
    const found = screenAfter(seen.screen, ctx.firstWords).includes(squeeze(expected.absent));
    return found
      ? {
          ok: false,
          evidence: `"${expected.absent}" is on the screen: ${screenLine(seen.screen, expected.absent)}`,
        }
      : { ok: true, evidence: `"${expected.absent}" never came` };
  }
  if ("sessionId" in expected) {
    const id = seen.pane?.sessionId;
    if (!id) return { ok: false, evidence: "the pane holds no session id" };
    return id === PLACEHOLDER_SESSION
      ? {
          ok: false,
          evidence: `the pane holds "${id}": the host named its session itself and told nobody, so a resume takes the latest session of the directory`,
        }
      : { ok: true, evidence: `session id: ${id}` };
  }
  if ("guard" in expected) {
    const want = expected.guard;
    const record = seen.guard.find(
      (r) =>
        r.decision === want.decision &&
        sinceCheck(r.at, ctx.since) &&
        r.reason.toLowerCase().includes(want.reason.toLowerCase()),
    );
    if (record)
      return { ok: true, evidence: `guard (GuardAsked, ${record.at}): ${record.decision}: ${record.reason}` };
    const kept = seen.guard.filter((r) => sinceCheck(r.at, ctx.since));
    return {
      ok: false,
      evidence:
        kept.length === 0
          ? `the pre-tool guard kept no ${want.decision} for this pane since the check began: its hook did not run, or did not see the command`
          : `the guard kept ${kept.map((r) => `${r.decision} (${r.reason})`).join("; ")}, no ${want.decision} about ${want.reason}`,
    };
  }
  if ("file" in expected) {
    const text = seen.files[expected.file.path];
    if (text === undefined) return { ok: false, evidence: `${expected.file.path} is gone` };
    return text.includes(expected.file.contains)
      ? { ok: true, evidence: `${expected.file.path} still holds "${expected.file.contains}"` }
      : {
          ok: false,
          evidence: `${expected.file.path} changed: it no longer holds "${expected.file.contains}"`,
        };
  }
  if ("commits" in expected) {
    const made = seen.git.commits - ctx.commitsBefore;
    const subject = expected.subject;
    const ok = made === expected.commits && (subject === undefined || seen.git.subject.includes(subject));
    return {
      ok,
      evidence: `commits: ${ctx.commitsBefore} → ${seen.git.commits}${made > 0 ? ` (last: ${seen.git.subject})` : ""}${ok ? "" : `; expected ${expected.commits} new${subject ? ` with "${subject}"` : ""}`}`,
    };
  }
  if ("consent" in expected) {
    const written = sinceCheck(seen.consents.writtenAt, ctx.since);
    const held = seen.consents.kinds.includes(expected.consent);
    if (!written)
      return {
        ok: false,
        evidence:
          "the user-prompt hook kept no consent since the check began: it did not run, or did not see the person's words",
      };
    return held
      ? {
          ok: false,
          evidence: `the person's consent (${expected.consent}) was kept at ${seen.consents.writtenAt}, and no command used it`,
        }
      : {
          ok: true,
          evidence: `the user-prompt hook kept the person's consent (${expected.consent}) at ${seen.consents.writtenAt}, and the command used it`,
        };
  }
  if ("noPrompt" in expected)
    return ctx.prompts.length === 0
      ? { ok: true, evidence: "the host asked for no approval" }
      : { ok: false, evidence: `the host asked: ${ctx.prompts.join("; ")}` };
  const at = seen.pane?.lastHookAt;
  return sinceCheck(at, ctx.since)
    ? { ok: true, evidence: `the session's hooks called in (last at ${at})` }
    : {
        ok: false,
        evidence: `no hook of the session called in since the check began${at ? ` (last at ${at})` : ""}`,
      };
}

/** The open permission question that is the host asking to trust the suite's own repository, if any. */
export function firstRunTrust(
  seen: LabView,
  repoMark: string,
): { readonly question: LabQuestion; readonly choice: string } | { readonly key: string } | undefined {
  const screen = tail(seen.screen, 30);
  if (
    !/trust (the files in )?this folder|trust this (folder|project)|quick safety check|do you trust/i.test(
      screen,
    )
  )
    return undefined;
  // Only the suite's own throwaway repository is ever trusted.
  if (!squeeze(screen).includes(squeeze(repoMark))) return undefined;
  const yes = (label: string) =>
    /^yes\b/i.test(label) && !/don.?t ask|always|auto mode|remember/i.test(label);
  const question = seen.questions.find((q) => q.source === "permission" && q.options.some(yes));
  if (question) return { question, choice: question.options.find(yes) as string };
  const key = /(\d)[.)]\s*Yes\b(?![^\n]*(?:don.?t ask|always|auto mode|remember))/i.exec(screen)?.[1];
  if (key) return { key };
  return cursorTo(screen, yes);
}

/**
 * An unnumbered menu (Claude Code 2.1.330's trust question: `❯ No, exit` over `Yes, I trust this
 * folder`): the arrow presses that move the cursor from its line to the option `wanted` takes,
 * Enter typed after them; undefined when the menu has no such option.
 */
function cursorTo(screen: string, wanted: (label: string) => boolean): { readonly key: string } | undefined {
  const lines = screen.split("\n").map((l) => l.trim());
  const cursor = lines.findIndex((l) => l.startsWith("❯"));
  if (cursor < 0) return undefined;
  const target = lines.findIndex((l) => wanted(l.replace(/^❯\s*/, "")));
  if (target < 0 || Math.abs(target - cursor) > 5) return undefined;
  const step = target > cursor ? "\u001b[B" : "\u001b[A";
  return { key: step.repeat(Math.abs(target - cursor)) };
}

/** The option of a question this pattern matches (case aside), if one does. */
export function optionMatching(q: LabQuestion, pattern: string): string | undefined {
  const re = new RegExp(pattern, "i");
  return q.options.find((o) => re.test(o));
}

/** The No of a host's approval: what the suite answers to a prompt no check waits for. */
export const refusalOf = (q: LabQuestion): string | undefined => optionMatching(q, "^no\\b");
