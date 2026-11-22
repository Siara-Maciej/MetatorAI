import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * What a pane's agent is doing (R3, ADR-0080), read without asking it: the host's hooks say it
 * works (a tool call), its screen says it waits for a person (the host's own permission prompt,
 * a question only a person answers), its output says it is quiet, its exit says it is over.
 */
export const PANE_STATES = ["working", "blocked", "waiting", "idle", "exited"] as const;
export type PaneState = (typeof PANE_STATES)[number];

/** A regular expression source, checked when the manifest is read. */
const pattern = z
  .string()
  .min(1)
  .refine(
    (p) => {
      try {
        new RegExp(p);
        return true;
      } catch {
        return false;
      }
    },
    { message: "not a valid regular expression" },
  );

/**
 * How to read a host's pane (`HostManifest` v1): the screen patterns of its permission prompt
 * (`blocked`) and of its own idle prompt (`idle`), how long without output or hook activity is
 * quiet, and whether its hooks run `metator guard` (then a hook call means `working`).
 */
export const HostManifestSchema = z.strictObject({
  host: z.string().regex(/^[a-z][a-z0-9-]*$/, "a host id: lowercase letters, digits, dashes"),
  screen: z
    .strictObject({
      /** The host asks the person at the keyboard (allow a tool, confirm, choose). */
      blocked: z.array(pattern).default([]),
      /** The host shows its prompt and waits for a next instruction. */
      idle: z.array(pattern).default([]),
      /** How many lines from the bottom of the screen the patterns are tried on: a prompt sits at the bottom. */
      lines: z.number().int().positive().default(6),
    })
    .default({ blocked: [], idle: [], lines: 6 }),
  /** No output and no hook call for this long is `idle` (unless the screen says otherwise). */
  quietMs: z.number().int().positive().default(15_000),
  /** The host runs the run's hooks, so a hook call is proof of work. */
  hooks: z.boolean().default(true),
});
export type HostManifest = z.output<typeof HostManifestSchema>;
export type HostManifestInput = z.input<typeof HostManifestSchema>;

export const HostManifestDocument = defineDocument("HostManifest", {
  latest: HostManifestSchema,
  errorCode: "INVALID_CONFIG",
  hint: "A host manifest: `host`, `screen.blocked` and `screen.idle` patterns, `quietMs`, `hooks`; metator/hosts/<host>.yml overrides the built-in one.",
});

/**
 * The manifests MetatorAI ships. Screen patterns are an approximation until calibrated on the
 * real host (ADR-0080); the hooks give a sure `working`, the exit a sure end.
 */
export const BUILTIN_MANIFESTS: readonly HostManifestInput[] = [
  {
    host: "copilot",
    screen: {
      blocked: [
        "Allow .* to run",
        "Do you want to (allow|run|continue|proceed)",
        "\\(y/n\\)|\\[Y/n\\]|\\[y/N\\]",
        "Yes, (allow|and don't ask again)",
        "Press enter to continue",
        "Confirm\\?|Continue\\?",
      ],
      idle: ["^> ?$", "^❯ ?$"],
    },
  },
  {
    host: "claude",
    screen: {
      blocked: [
        "Do you want to (proceed|make this edit|run|allow)",
        "Yes, and don't ask again",
        "Esc to cancel",
        "\\(y/n\\)|\\[Y/n\\]",
      ],
      idle: ["^> ?$", "^❯ ?$"],
    },
  },
  {
    host: "opencode",
    screen: {
      blocked: ["Allow .*\\?", "\\(y/n\\)|\\[Y/n\\]", "Do you want to"],
      idle: ["^> ?$", "^❯ ?$"],
    },
  },
  {
    // The scenario host prints `question [a / b]` and reads a line: a prompt only a person answers.
    host: "scenario",
    screen: { blocked: ["\\? \\[[^\\]]+\\]\\s*$"], idle: [] },
    quietMs: 2_000,
    hooks: false,
  },
];

/** A manifest for a host MetatorAI knows nothing about: only quiet and exit are read. */
export function genericManifest(host: string): HostManifest {
  return HostManifestSchema.parse({ host });
}

/** A host's own prompt counts as idle once the screen settled (not mid-redraw). */
const PROMPT_SETTLE_MS = 1_000;

export interface PaneStateInput {
  readonly alive: boolean;
  readonly exitCode?: number;
  /** The last lines of the screen, without terminal escapes. */
  readonly screen: string;
  readonly manifest: HostManifest;
  readonly now: Date;
  readonly lastOutputAt: Date;
  /** The last hook call from the pane (`metator guard …` carrying the pane's token). */
  readonly lastHookAt?: Date;
  /** A MetatorAI question of the pane's run waits for a person. */
  readonly openQuestion: boolean;
}

export interface PaneStateView {
  readonly state: PaneState;
  /**
   * Why, in one line a person reads: a blocked pane's prompt as `readHostPrompt` reads it from the
   * rendered screen (`Bash command: metator workflow list — This command requires approval`),
   * the idle line, or why else. Never longer than `REASON_MAX`.
   */
  readonly reason: string;
  /** A blocked pane's numbered choices, when its prompt is a menu: the key that picks each. */
  readonly menu?: readonly MenuChoice[];
}

/** One choice of a host's numbered menu: the key a person presses for it, and its words. */
export interface MenuChoice {
  readonly key: string;
  readonly label: string;
}

/** The longest reason a pane's state gives. */
export const REASON_MAX = 200;

/**
 * The state of a pane, in order of certainty: the exit; the host's permission prompt on the
 * screen; a question that waits for a person; recent output or a recent hook call; the host's
 * own idle prompt or long quiet.
 */
export function paneStateOf(input: PaneStateInput): PaneStateView {
  if (!input.alive) return { state: "exited", reason: `exited with ${input.exitCode ?? "no code"}` };
  const lines = input.screen
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-input.manifest.screen.lines);
  const blocked = matchLine(lines, input.manifest.screen.blocked);
  if (blocked !== undefined) {
    const read = readHostPrompt(input.screen, blocked);
    return {
      state: "blocked",
      reason: read.text,
      ...(read.options.length > 0 ? { menu: read.options } : {}),
      ...(read.command ? { command: read.command } : {}),
    };
  }
  if (input.openQuestion) return { state: "waiting", reason: "a question waits for a person" };
  const last = Math.max(input.lastOutputAt.getTime(), input.lastHookAt?.getTime() ?? 0);
  const quietFor = input.now.getTime() - last;
  const idle = matchLine(lines, input.manifest.screen.idle);
  if (idle !== undefined && quietFor >= PROMPT_SETTLE_MS) return { state: "idle", reason: idle };
  if (quietFor < input.manifest.quietMs) {
    const hook = input.lastHookAt && input.lastHookAt.getTime() >= input.lastOutputAt.getTime();
    return { state: "working", reason: hook ? "a hook call just now" : "output just now" };
  }
  return { state: "idle", reason: `quiet for ${Math.round(quietFor / 1000)} s` };
}

/** The last screen line a pattern matches, or nothing. */
function matchLine(lines: readonly string[], patterns: readonly string[]): string | undefined {
  if (patterns.length === 0) return undefined;
  const regexes = patterns.map((p) => new RegExp(p));
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (regexes.some((r) => r.test(line))) return line.trim();
  }
  return undefined;
}

/** Box frames and the menu's pointer: no part of a prompt's words. */
const FRAME = /^[\s│┃|╭╮╰╯┌┐└┘├┤─━]+|[\s│┃|╭╮╰╯┌┐└┘├┤─━]+$/g;
/** A numbered choice: `❯ 1. Yes`, `2) No`. */
const CHOICE = /^(?:[❯›>]\s*)?(\d{1,2})[.)]\s+(.+)$/;
/** A transcript line above a prompt (a tool call, its output, a spinner): not the prompt. */
const TRANSCRIPT = /^[●⎿✻✶✳✢✽·]/;
/** The line that says why the host asks: its need, else its question. */
const NEED = /requires? (your )?approval|needs? (your )?(approval|permission)|permission/i;
/** The hints under or in a prompt: how to cancel or amend it, a tip about the host's modes. */
const HINT = /^(esc to|press |tab to|ctrl\+|tip:)/i;
/**
 * The gutter Claude Code draws before each line of a command that runs over several lines (`│`,
 * one column in): a frame, never part of the command.
 */
const GUTTER = /^\s{0,2}[│┃](?:\s|$)/;
/** A dashed rule: Claude Code draws one above and one below the command it asks to run. */
const DASHED = /^[╌┄┈]{3,}$/;

/** A text cut to `max` characters, with an ellipsis when it was longer. */
const bounded = (text: string, max = REASON_MAX) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * A blocked pane's prompt as a person reads it, from the rendered screen and the line that matched:
 * a host's dialog (a box, or a numbered menu) as one line, `<what> : <detail> — <why it asks>`
 * (`Bash command: metator workflow list — This command requires approval`), with its numbered
 * choices; any other prompt (an agent's `Which currency? [PLN / EUR]`) is its own line. Bounded.
 */
export function readHostPrompt(
  screen: string,
  line: string,
): { readonly text: string; readonly options: readonly MenuChoice[]; readonly command?: string } {
  const clean = (l: string) => l.replace(FRAME, "").trim();
  const raw = screen.split("\n");
  const rows = raw.map(clean);
  const wanted = clean(line);
  let at = -1;
  for (let i = rows.length - 1; i >= 0; i--)
    if (wanted !== "" && (rows[i] as string).includes(wanted)) {
      at = i;
      break;
    }
  if (at < 0) return { text: bounded(wanted), options: [] };
  // The dialog: its box when it has one, else the lines after the transcript above it.
  let start = Math.max(0, at - 15);
  let end = Math.min(rows.length - 1, at + 10);
  let boxed = false;
  for (let i = at; i >= start; i--)
    if (/^\s*[╭┌]/.test(raw[i] as string)) {
      start = i + 1;
      boxed = true;
      break;
    }
  if (!boxed)
    for (let i = at; i >= start; i--)
      if (TRANSCRIPT.test(rows[i] as string)) {
        start = i + 1;
        break;
      }
  for (let i = at; i <= end; i++)
    if (/^\s*[╰└]/.test(raw[i] as string)) {
      end = i - 1;
      break;
    }
  // The command itself, when the host draws it between dashed rules: what the person decides on,
  // whole (every line between the rules, a line the terminal wrapped joined to the next).
  const command = commandBetweenRules(raw, rows, start, end);
  const inCommand = new Set(command?.rows ?? []);
  const region = rows
    .map((r, i) => ({ r, i }))
    .slice(start, end + 1)
    .filter(({ r, i }) => r !== "" && !inCommand.has(i));
  const options: MenuChoice[] = [];
  const words: string[] = [];
  for (const { r } of region) {
    const choice = CHOICE.exec(r);
    if (choice) options.push({ key: choice[1] as string, label: (choice[2] as string).trim() });
    else if (DASHED.test(r)) continue;
    else if (!HINT.test(r) && !TRANSCRIPT.test(r)) words.push(r);
  }
  const menu = options.length >= 2 && options[0]?.key === "1" ? options : [];
  if (menu.length === 0 && !boxed) return { text: bounded(wanted), options: [] };
  const need = words.find((w) => NEED.test(w)) ?? words.find((w) => w.endsWith("?")) ?? wanted;
  // A command: the prompt starts with it (its first line), then why the host asks.
  if (command)
    return {
      text: bounded(`${command.text.split("\n")[0] as string} — ${need}`),
      options: menu,
      command: command.text,
    };
  const [title, detail] = words.filter((w) => w !== need && !w.endsWith("?"));
  const text = title ? `${title}${detail ? `: ${detail}` : ""} — ${need}` : need;
  return { text: bounded(text), options: menu };
}

/**
 * The lines between the first two dashed rules of a dialog, as one command: the indent and frame
 * (Claude Code's `│` gutter too) taken off, a line as wide as the rules (the terminal wrapped it)
 * joined to the next as it is, a gutter line Claude Code wrapped at a word joined with a space,
 * any other line break kept. Undefined when the dialog has no such rules.
 */
function commandBetweenRules(
  raw: readonly string[],
  rows: readonly string[],
  start: number,
  end: number,
): { readonly text: string; readonly rows: readonly number[] } | undefined {
  const rules: number[] = [];
  for (let i = start; i <= end && rules.length < 2; i++) if (DASHED.test(rows[i] as string)) rules.push(i);
  if (rules.length < 2) return undefined;
  const [above, below] = rules as [number, number];
  const width = (raw[above] as string).trimEnd().length;
  const lines: number[] = [];
  for (let i = above + 1; i < below; i++) lines.push(i);
  const guttered = lines.map((i) => GUTTER.test(raw[i] as string));
  const body = lines.map((i, k) =>
    guttered[k]
      ? (raw[i] as string).replace(GUTTER, "").trimEnd()
      : (raw[i] as string)
          .replace(/^[│┃|]/, "")
          .replace(/^\s/, "")
          .replace(/\s*[│┃|]?\s*$/, ""),
  );
  let text = "";
  body.forEach((line, k) => {
    if (k > 0) {
      const above = (raw[lines[k - 1] as number] as string).trimEnd().length;
      // Behind the gutter Claude Code wraps at words: a line the next word would not have fit on.
      const wrapped =
        guttered[k - 1] &&
        guttered[k] &&
        body[k - 1] !== "" &&
        line !== "" &&
        above + 1 + (line.split(" ")[0] as string).length > width - 1;
      text += wrapped ? " " : above >= width - 1 ? "" : "\n";
    }
    text += line;
  });
  text = text.replace(/^\n+|\n+$/g, "");
  return text === "" ? undefined : { text, rows: [above, below, ...lines] };
}

/** The choices on a host's permission prompt in the inbox: a person goes to the pane, or leaves it. */
export const ATTACH_PANE = "Attach and answer in the pane";
export const LEAVE_PANE = "Leave it";
export const ANSWERED_IN_PANE = "Answered in the pane";

export function hostPromptText(host: string, paneId: string, line: string): string {
  return `${host} waits for your answer in pane ${paneId}: ${line}`;
}

/** What a blocked pane's screen line asks: a question an agent asks with its options, or a host's permission prompt. */
export interface TerminalQuestion {
  readonly kind: "question" | "permission";
  /** The question in its own words (a permission prompt: the line as it is). */
  readonly prompt: string;
  /** The choices a question names (`[PLN / EUR]`); none for a permission prompt. */
  readonly options: readonly string[];
}

/** The words of a host asking leave to use a tool, whatever its choices. */
const PERMISSION_WORDS =
  /\b(allow|permission|proceed|make this edit|don't ask again|esc to cancel|press enter)\b|\(y\/n\)|\[y\/n\]|do you want to (run|allow|continue)/i;

/**
 * A blocked pane's screen line read as a person reads it: `Which currency? [PLN / EUR]` is a
 * question with two options; `Allow … (y/n)` or a single choice is the host's own prompt. The
 * frame and escapes of the terminal are not part of the words.
 */
export function terminalQuestionOf(line: string): TerminalQuestion {
  const clean = line
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are what is removed
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/^[\s│|>❯•*?-]+/, "")
    .trim();
  const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(clean);
  const options = m
    ? (m[2] as string)
        .split(/\s*\/\s*/)
        .map((o) => o.trim())
        .filter((o) => o !== "")
    : [];
  if (PERMISSION_WORDS.test(clean) || options.length < 2)
    return { kind: "permission", prompt: clean, options: [] };
  return { kind: "question", prompt: (m?.[1] ?? clean).trim(), options };
}

/**
 * What a person typed at a terminal prompt, read back from the screen: the first line after the
 * prompt's last showing (the terminal echoes what was typed). Undefined when nothing follows it.
 */
export function answerAfter(screen: string, prompt: string): string | undefined {
  const lines = screen
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are what is removed
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n|\r/)
    .map((l) => l.trim());
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if ((lines[i] as string).includes(prompt)) {
      at = i;
      break;
    }
  if (at < 0) return undefined;
  const typed = lines.slice(at + 1).find((l) => l !== "");
  return typed === undefined || typed === "" ? undefined : typed;
}
