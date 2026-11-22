import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * The host conformance suite (ADR-0098): the same checks for every interactive host (Claude Code,
 * Copilot CLI), each proving its claim through what MetatorAI itself observes of a real session in
 * a throwaway repository: the pane's rendered screen, its state, the pane questions in the inbox,
 * the guard's records (`GuardAsked`), the person's consents, the host's session id, git. Never
 * through the model's words alone: a check's expected words are an uppercase form the session was
 * never shown, so only an agent that read and acted can print them.
 *
 * The checks are data (`CONFORMANCE_CHECKS`); `RunHostConformance` plays them through a
 * `ConformanceLab`, and the result is a `HostConformance` document anyone can read without logging
 * in to a host. Two documents of two hosts compared (`diffConformance`) list the parity gaps.
 */

export const CONFORMANCE_RESULTS = ["pass", "fail", "skipped"] as const;
export type ConformanceResult = (typeof CONFORMANCE_RESULTS)[number];

/** The longest evidence a check keeps: the screen lines or the records that prove it. */
export const EVIDENCE_MAX = 2000;

/** What one check found. */
export const ConformanceCheckResultSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  result: z.enum(CONFORMANCE_RESULTS),
  evidence: z.string().max(EVIDENCE_MAX),
  tookMs: z.number().int().nonnegative(),
});
export type ConformanceCheckResult = z.output<typeof ConformanceCheckResultSchema>;

/** One run of the suite against one host (`<out>/conformance-<host>-<cli version>.json`). */
export const HostConformanceSchema = z.strictObject({
  host: z.string().min(1),
  /** What the host's CLI says of itself (`claude --version`), its version number when it has one. */
  cliVersion: z.string().min(1),
  os: z.string().min(1),
  metatorVersion: z.string().min(1),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  checks: z.array(ConformanceCheckResultSchema),
});
export type HostConformance = z.output<typeof HostConformanceSchema>;

export const HostConformanceDocument = defineDocument("HostConformance", {
  latest: HostConformanceSchema,
  hint: "Written by `metator host conformance --host <host>`; compare two with `metator host conformance diff <a.json> <b.json>`.",
});

/** The two sessions the checks work in: a thread's chat (as a person opens one), and a session of a run. */
export type ConformanceSession = "chat" | "run";

/** What a check waits for or holds true, as MetatorAI observes it. */
export type ConformanceExpectation =
  /** These words are on the screen after the last words the session was given (whitespace aside). */
  | { readonly screen: string }
  /** These words are not on the screen after the first words of this check. */
  | { readonly absent: string }
  /** The pane knows the host's own session id (not the placeholder of a host that names none). */
  | { readonly sessionId: "known" }
  /** The guard's pre-tool hook kept this decision since the check began, its reason naming this. */
  | { readonly guard: { readonly decision: "deny" | "ask"; readonly reason: string } }
  /** A file of the repository holds these words. */
  | { readonly file: { readonly path: string; readonly contains: string } }
  /** This many commits were made since the check began; the last one's subject holds `subject`. */
  | { readonly commits: number; readonly subject?: string }
  /** The user-prompt hook kept the person's consent of this kind since the check began, and a command used it. */
  | { readonly consent: string }
  /** The host asked for no approval in the pane during the check. */
  | { readonly noPrompt: true }
  /** A hook of the session called the daemon since the check began. */
  | { readonly hookCalled: true };

/** One step of a check, played in order; any step that cannot be done fails the check. */
export type ConformanceStep =
  /** Opens the session in a pane, as a person does (the chat: a new thread; the run: its session). */
  | { readonly open: ConformanceSession }
  /** Waits until the session's turn is over: idle at its prompt, no approval open, settled. */
  | { readonly rest: true }
  /** Waits until the session works (output, a hook call). */
  | { readonly working: true }
  /** A person types these words into the session and sends them. */
  | { readonly say: string }
  /** `metator session tell`: the words typed into the session once its agent is idle. */
  | { readonly tell: string }
  /** `metator session interrupt`: Esc, then these words. */
  | { readonly interrupt: string }
  /** A file written into the repository (and staged): what the check's command acts on. */
  | { readonly write: { readonly path: string; readonly text: string; readonly stage: boolean } }
  /** The daemon killed (SIGKILL) and started again without restoring: the pane paused, then continued. */
  | { readonly restart: true }
  /** Waits for a question of the session's pane in the inbox (its prompt or command holding `matches`, or these options). */
  | {
      readonly question: {
        readonly source: "permission" | "agent";
        readonly matches?: string;
        readonly options?: readonly string[];
      };
    }
  /** Answers the question waited for through the inbox, with the option this pattern matches (case aside). */
  | { readonly answer: string }
  | { readonly expect: ConformanceExpectation };

export interface ConformanceCheck {
  readonly id: string;
  readonly title: string;
  /** What passing proves, in one sentence (the report and the docs say it). */
  readonly proves: string;
  readonly session: ConformanceSession;
  readonly steps: readonly ConformanceStep[];
}

/** The thread the chat is opened as: the title a person would give it (`{run}`: this run's word). */
export const CONFORMANCE_THREAD_TITLE = "Conformance {run}";

/** What a run's session is told when it opens (it has no agent file of its own: the host's own agent). */
export const CONFORMANCE_RUN_PROMPT =
  "This is MetatorAI's host conformance suite, in a throwaway repository. Lines that begin with [metator] From the person carry the person's words: do exactly what they say and nothing else. Use no tool unless a message asks for one. Now say only: Ready.";

/** The workflow of the run whose session the suite steers: one person's gate, so nothing moves it. */
export const CONFORMANCE_WORKFLOW = "conformance";

const UPPER = "Reply with only the uppercase form of this word: {nonce}";

/**
 * The checks, in the order they run: the chat's first (it opens as a person's chat does), then the
 * run's session (`session tell` and `interrupt` steer a run's sessions only, ADR-0093). The same
 * for every host; a host that fails one has a parity gap (ADR-0098).
 */
export const CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  {
    id: "start",
    title: "A session opens in the pane and answers",
    proves:
      "the host starts as a thread's chat in a pane the daemon owns, answers a one-line prompt and comes to rest at its prompt",
    session: "chat",
    steps: [
      { open: "chat" },
      { rest: true },
      {
        say: `This is MetatorAI's host conformance suite, in a throwaway repository: I ask for small things, one at a time. ${UPPER}`,
      },
      { rest: true },
      { expect: { screen: "{NONCE}" } },
    ],
  },
  {
    id: "session-id",
    title: "MetatorAI knows the host's session id",
    proves: "the pane holds the host's own id of its session, the one a resume names",
    session: "chat",
    steps: [{ expect: { sessionId: "known" } }],
  },
  {
    id: "resume",
    title: "The session survives the daemon, resumed by its id",
    proves:
      "after the daemon is killed (SIGKILL) and started again, the pane is paused, continues in the same session, and the agent still knows a word it was told before",
    session: "chat",
    steps: [
      { say: "Remember this code word for later in this conversation: {nonce}. Reply with only: OK" },
      { rest: true },
      { restart: true },
      { rest: true },
      { say: "What is the code word I asked you to remember? Reply with only the uppercase form of it." },
      { rest: true },
      { expect: { screen: "{NONCE}" } },
    ],
  },
  {
    id: "hook-pre-tool-deny",
    title: "The pre-tool hook denies a command that never runs",
    proves:
      "the host runs the pre-tool hook before a shell command and honours its deny: the guard kept the denial and the repository is unchanged",
    session: "chat",
    steps: [
      { write: { path: "README.md", text: "# Conformance\n\nKept by the guard: {nonce}\n", stage: false } },
      {
        say: "A test of MetatorAI's guard: try once to run exactly this shell command with your shell tool: `git reset --hard`. The guard is expected to refuse it. Do not try anything else; then say in one line what happened.",
      },
      { rest: true },
      { expect: { guard: { decision: "deny", reason: "git reset --hard" } } },
      { expect: { file: { path: "README.md", contains: "{nonce}" } } },
      { expect: { noPrompt: true } },
    ],
  },
  {
    id: "hook-pre-tool-ask",
    title: "The pre-tool hook's ask becomes the host's approval prompt",
    proves:
      "the host honours the hook's ask with its own approval prompt, which reaches the inbox as a pane question with the command and the guard's reason; answered No there, nothing is committed",
    session: "chat",
    steps: [
      { write: { path: "conformance/ask.txt", text: "{nonce}\n", stage: true } },
      {
        say: 'A test of the host\'s approval prompt: run exactly this shell command once with your shell tool: `git commit -m "conformance ask {nonce}"`. If it is not approved, do not retry it and do nothing else.',
      },
      { question: { source: "permission", matches: "git commit" } },
      { expect: { guard: { decision: "ask", reason: "git commit" } } },
      { answer: "^no\\b" },
      { rest: true },
      { expect: { commits: 0 } },
    ],
  },
  {
    id: "word-consent",
    title: "The person's word is consent to a guarded command",
    proves:
      'the person\'s message "commit it" goes through the user-prompt hook, which keeps their consent; the next git commit uses it and runs without a prompt',
    session: "chat",
    steps: [
      { write: { path: "conformance/consent.txt", text: "{nonce}\n", stage: true } },
      { say: 'commit it, with the message "conformance consent {nonce}"' },
      { rest: true },
      { expect: { consent: "commit" } },
      { expect: { commits: 1, subject: "{nonce}" } },
      { expect: { noPrompt: true } },
    ],
  },
  {
    id: "unprompted-allow",
    title: "What the hook allows runs without a prompt",
    proves:
      "the host honours the pre-tool hook's allow: MetatorAI's own command and a read-only git command run without the host asking",
    session: "chat",
    steps: [
      {
        say: `Run these two shell commands with your shell tool, one at a time: \`metator rules list\`, then \`git status\`. After both, ${UPPER.charAt(0).toLowerCase()}${UPPER.slice(1)}`,
      },
      { rest: true },
      { expect: { screen: "{NONCE}" } },
      { expect: { noPrompt: true } },
      { expect: { hookCalled: true } },
    ],
  },
  {
    id: "text-question",
    title: "A question asked in words becomes a card",
    proves:
      "a question the agent asks as plain text with lettered choices reaches the inbox as a pane question with those choices, and the answer given there reaches the agent",
    session: "chat",
    steps: [
      {
        say: "Ask me in plain words in your reply, not with a tool or a menu, which colour I prefer, with two lettered choices: a) red, b) blue. Then stop and wait for my answer. When I have answered, reply with only the word COLOUR, a dash, and my colour in uppercase.",
      },
      { question: { source: "agent", options: ["red", "blue"] } },
      { answer: "blue" },
      { rest: true },
      { expect: { screen: "COLOUR-BLUE" } },
    ],
  },
  {
    id: "mcp-or-tools",
    title: "The agent's MetatorAI commands are callable",
    proves:
      "a MetatorAI command the agent files allow (`metator thread show`) runs from the session and its answer comes back to the agent",
    session: "chat",
    steps: [
      {
        say: "Run `metator thread show` with your shell tool and reply with only the title of this thread in uppercase.",
      },
      { rest: true },
      { expect: { screen: "CONFORMANCE {RUN}" } },
      { expect: { noPrompt: true } },
    ],
  },
  {
    id: "tell",
    title: "`metator session tell` reaches an idle session",
    proves: "the person's words told to a run's idle session are typed into it, and the agent acts on them",
    session: "run",
    steps: [
      { open: "run" },
      { rest: true },
      { tell: UPPER },
      { rest: true },
      { expect: { screen: "{NONCE}" } },
    ],
  },
  {
    id: "interrupt",
    title: "`metator session interrupt` stops the work and is heard",
    proves:
      "while the agent works on a long task, an interrupt stops it and the new words are taken: the long task never ends",
    session: "run",
    steps: [
      { rest: true },
      {
        tell: "Write the numbers from 1 to 1000, one per line, with nothing else and without any tool. After 1000, write LIST-END.",
      },
      { working: true },
      { interrupt: `Stop now. ${UPPER}` },
      { rest: true },
      { expect: { screen: "{NONCE}" } },
      { expect: { absent: "LIST-END" } },
    ],
  },
];

export const CONFORMANCE_CHECK_IDS: readonly string[] = CONFORMANCE_CHECKS.map((c) => c.id);

/**
 * A check's words with its own word (`{nonce}`, `{NONCE}`: lowercase as given, the uppercase form
 * expected back) and the run's (`{run}`, `{RUN}`: the thread's title).
 */
export function fillConformance(
  text: string,
  vars: { readonly nonce: string; readonly run: string },
): string {
  return text
    .replaceAll("{nonce}", vars.nonce)
    .replaceAll("{NONCE}", vars.nonce.toUpperCase())
    .replaceAll("{run}", vars.run)
    .replaceAll("{RUN}", vars.run.toUpperCase());
}

/** The version number in what a CLI says of itself (`2.1.329 (Claude Code)`), else its first line. */
export function cliVersionOf(output: string): string {
  const found = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/.exec(output);
  if (found) return found[0];
  const line = output.trim().split("\n")[0]?.trim() ?? "";
  return line === "" ? "unknown" : line.slice(0, 60);
}

/** Where a run of the suite is kept, its version made safe for a file name. */
export function conformanceFileName(host: string, cliVersion: string): string {
  return `conformance-${host}-${cliVersion.replace(/[^\w.-]+/g, "_")}`;
}

/** Evidence bounded as the document keeps it: the start, with an ellipsis when it was longer. */
export function boundEvidence(text: string): string {
  return text.length <= EVIDENCE_MAX ? text : `${text.slice(0, EVIDENCE_MAX - 1)}…`;
}

/** Every check passed: none failed and none was skipped. */
export function conformancePassed(doc: Pick<HostConformance, "checks">): boolean {
  return doc.checks.length > 0 && doc.checks.every((c) => c.result === "pass");
}

/** -1, 0 or 1 as version `a` is older than, the same as or newer than `b`, by their numbers. */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) => (/\d+(?:\.\d+)*/.exec(v)?.[0] ?? "").split(".").map(Number);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** One check whose result differs between two runs of the suite: a parity gap. */
export interface ConformanceDifference {
  readonly id: string;
  readonly title: string;
  readonly a: ConformanceResult | "missing";
  readonly b: ConformanceResult | "missing";
}

/** Every check whose result differs between the two runs, in the suite's order (then any other). */
export function diffConformance(a: HostConformance, b: HostConformance): ConformanceDifference[] {
  const ids = [
    ...CONFORMANCE_CHECK_IDS,
    ...[...a.checks, ...b.checks].map((c) => c.id).filter((id) => !CONFORMANCE_CHECK_IDS.includes(id)),
  ];
  const out: ConformanceDifference[] = [];
  for (const id of [...new Set(ids)]) {
    const x = a.checks.find((c) => c.id === id);
    const y = b.checks.find((c) => c.id === id);
    if (!x && !y) continue;
    const ra: ConformanceDifference["a"] = x?.result ?? "missing";
    const rb: ConformanceDifference["b"] = y?.result ?? "missing";
    if (ra !== rb) out.push({ id, title: x?.title ?? y?.title ?? id, a: ra, b: rb });
  }
  return out;
}

const MARK: Record<ConformanceResult, string> = { pass: "pass", fail: "FAIL", skipped: "skipped" };

/** The report a person reads (`report.md`): never parsed, no header. */
export function renderConformance(doc: HostConformance): string {
  const count = (r: ConformanceResult) => doc.checks.filter((c) => c.result === r).length;
  const lines = [
    `# Host conformance: ${doc.host} ${doc.cliVersion}`,
    "",
    `- Host: ${doc.host}, CLI ${doc.cliVersion}`,
    `- MetatorAI ${doc.metatorVersion} on ${doc.os}`,
    `- From ${doc.startedAt} to ${doc.endedAt}`,
    `- ${count("pass")} passed, ${count("fail")} failed, ${count("skipped")} skipped`,
    "",
    "| Check | Result | Took |",
    "|-------|--------|------|",
    ...doc.checks.map(
      (c) => `| ${c.id}: ${c.title} | ${MARK[c.result]} | ${Math.round(c.tookMs / 1000)} s |`,
    ),
  ];
  for (const c of doc.checks) {
    const proves = CONFORMANCE_CHECKS.find((x) => x.id === c.id)?.proves;
    lines.push("", `## ${c.id}: ${MARK[c.result]}`, "", ...(proves ? [`Proves: ${proves}.`, ""] : []));
    lines.push("```", c.evidence === "" ? "(no evidence)" : c.evidence, "```");
  }
  return `${lines.join("\n")}\n`;
}

/** The suite's last passing run with a host, as `metator doctor` reports it. */
export interface ConformanceSeen {
  readonly host: string;
  /** The last run where every check passed. */
  readonly passed?: { readonly cliVersion: string; readonly at: string };
  /** The last run of all, when it did not pass. */
  readonly last?: { readonly cliVersion: string; readonly at: string; readonly failed: number };
  /** The version installed here now, when the host can be asked. */
  readonly installed?: string;
}

/** The runs kept, by host: the last passing one, and the last one when it failed. */
export function conformanceSeen(docs: readonly HostConformance[]): ConformanceSeen[] {
  const hosts = [...new Set(docs.map((d) => d.host))].sort();
  return hosts.map((host) => {
    const mine = docs.filter((d) => d.host === host).sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    const passed = mine.filter(conformancePassed).at(-1);
    const last = mine.at(-1) as HostConformance;
    return {
      host,
      ...(passed ? { passed: { cliVersion: passed.cliVersion, at: passed.endedAt } } : {}),
      ...(last !== passed
        ? {
            last: {
              cliVersion: last.cliVersion,
              at: last.endedAt,
              failed: last.checks.filter((c) => c.result !== "pass").length,
            },
          }
        : {}),
    };
  });
}

/** `metator doctor`'s line for a host: ok when it passed with this version or an older one; a warning otherwise. */
export function conformanceLine(seen: ConformanceSeen): {
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly fix?: string;
} {
  const fix = `metator host conformance --host ${seen.host}`;
  if (!seen.passed)
    return {
      status: "warn",
      message: `${seen.host}: the suite never passed here (last run with ${seen.last?.cliVersion ?? "?"} on ${day(seen.last?.at)}: ${seen.last?.failed ?? 0} check(s) did not pass)`,
      fix,
    };
  const line = `last passed with ${seen.host} ${seen.passed.cliVersion} on ${day(seen.passed.at)}`;
  if (seen.installed && compareVersions(seen.installed, seen.passed.cliVersion) < 0)
    return {
      status: "warn",
      message: `${line}; ${seen.host} ${seen.installed} installed here is older`,
      fix,
    };
  return { status: "ok", message: line };
}

const day = (at: string | undefined) => (at ? at.slice(0, 10) : "?");
