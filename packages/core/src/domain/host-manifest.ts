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
  /** The screen line that decided it (blocked, idle) or why else. */
  readonly reason: string;
}

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
  if (blocked !== undefined) return { state: "blocked", reason: blocked };
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

/** The choices on a host's permission prompt in the inbox: a person goes to the pane, or leaves it. */
export const ATTACH_PANE = "Attach and answer in the pane";
export const LEAVE_PANE = "Leave it";
export const ANSWERED_IN_PANE = "Answered in the pane";

export function hostPromptText(host: string, paneId: string, line: string): string {
  return `${host} waits for your answer in pane ${paneId}: ${line}`;
}
