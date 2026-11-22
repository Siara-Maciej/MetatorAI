import { z } from "zod";

/**
 * Dangerous commands, in one place (`guard.commands` in metator.config, ADR-0094): what an agent
 * never runs, what it runs only with the person's consent, and what is allowed although a
 * broader pattern asks. Both hosts read this list: the pre-tool guard decides from it, and
 * Copilot's process-level deny list is derived from it.
 *
 * A pattern is a command's words: the program first; for `git`, the next word is the subcommand
 * (found after git's own options, so a commit message that says "push" is no push); every other
 * word must be among the command's arguments. A long flag may end with `*` (`--force*`); a short
 * flag (`-f`) also matches inside a cluster (`-xdf`).
 */
const pattern = z.string().min(1);

/** Never: they lose work, rewrite shared history or delete the repository. */
export const DEFAULT_NEVER: readonly string[] = [
  "git push --force*",
  "git push -f",
  "git reset --hard",
  "git clean -f",
  "git rebase -i",
  "git rebase --interactive",
  "git filter-branch",
  "git filter-repo",
  "rm -r /",
  "rm -r /*",
  "rm -r ~",
  "rm -r .",
  "rm -r ..",
  "rm -r *",
  "rm -r .git",
];
/** Only with the person's consent: a click on the host's prompt, or their word in the chat. */
export const DEFAULT_ASK_V14: readonly string[] = ["git commit", "git push", "git merge", "git rebase"];
/** v15 (ADR-0097): approving a pull request at its host is the person's decision too (kind `approve`). */
export const APPROVE_PATTERN = "metator review approve";
export const DEFAULT_ASK: readonly string[] = [...DEFAULT_ASK_V14, APPROVE_PATTERN];

const commandsSchema = (ask: readonly string[]) =>
  z.strictObject({
    never: z.array(pattern).default([...DEFAULT_NEVER]),
    ask: z.array(pattern).default([...ask]),
    /** Passes although an `ask` pattern matches (`git commit --dry-run`); never lifts a `never`. */
    allow: z.array(pattern).default([]),
  });
/** The command lists as MetatorConfig v13 and v14 had them (their `ask` default). */
const GuardCommandsV14Schema = commandsSchema(DEFAULT_ASK_V14);
export const GuardCommandsSchema = commandsSchema(DEFAULT_ASK);
export type GuardCommands = z.output<typeof GuardCommandsSchema>;
export const DEFAULT_GUARD_COMMANDS: GuardCommands = GuardCommandsSchema.parse({});

/** `guard` as MetatorConfig v13 had it: the command lists, and how long a consent in words holds. */
export const GuardConfigV13Schema = z.strictObject({
  commands: GuardCommandsV14Schema.default(GuardCommandsV14Schema.parse({})),
  /** Minutes a consent given in words holds; it is used once, for one command of its kind. */
  consentMinutes: z.number().int().min(1).max(120).default(10),
});

/**
 * `guard` in metator.config. v14 adds `prompts`: who answers for what is known to be safe.
 * `metator` (the default): the pre-tool hook lets MetatorAI's own commands, read-only commands,
 * edits inside the repository and the repository's own checks run without the host's approval
 * prompt; everything else keeps the host's prompt. `host`: the hook only denies and asks, and
 * the host prompts as it does by itself.
 */
export const GuardConfigV14Schema = z.strictObject({
  ...GuardConfigV13Schema.shape,
  prompts: z.enum(["metator", "host"]).default("metator"),
});
/** `guard` of MetatorConfig v15: the same, with `metator review approve` among the default `ask`. */
export const GuardConfigSchema = z.strictObject({
  ...GuardConfigV14Schema.shape,
  commands: GuardCommandsSchema.default(DEFAULT_GUARD_COMMANDS),
});
export type GuardConfig = z.output<typeof GuardConfigSchema>;
export const DEFAULT_GUARD_CONFIG: GuardConfig = GuardConfigSchema.parse({});

/**
 * What a host adapter is given of the guard when it is built: the command lists, and, when
 * MetatorAI answers for what is safe (`guard.prompts: metator`), the allow list for a host that
 * takes one before it starts (`allowToolsOf`).
 */
export interface HostGuard extends GuardCommands {
  readonly unprompted?: readonly string[];
}

export interface CommandVerdict {
  readonly level: "never" | "ask" | "allow";
  /** The pattern that decided (never, ask). */
  readonly pattern?: string;
  /** What a consent is given for: git's subcommand (`commit`), else the pattern's second word. */
  readonly kind?: string;
}

const basename = (word: string): string => word.split(/[\\/]/).pop() ?? word;

/** git's own options that take a value as the next word. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** The index of git's subcommand in a git command, after git's own options. */
function gitSubcommandAt(argv: readonly string[]): number {
  let i = 1;
  while (i < argv.length) {
    const word = argv[i] as string;
    if (GIT_VALUE_OPTIONS.has(word)) i += 2;
    else if (word.startsWith("-")) i += 1;
    else return i;
  }
  return -1;
}

function wordMatches(want: string, arg: string): boolean {
  if (want.startsWith("--")) {
    const name = arg.split("=")[0] as string;
    return want.endsWith("*") ? arg.startsWith(want.slice(0, -1)) : arg === want || name === want;
  }
  // A short flag: itself, or one letter of a cluster (`-xdf` holds `-f`).
  if (/^-[A-Za-z]$/.test(want)) return /^-[A-Za-z]+$/.test(arg) && arg.includes(want[1] as string);
  return arg === want;
}

/** Whether a command (its words) is what a pattern names. */
export function matchesCommand(patternText: string, argv: readonly string[]): boolean {
  const want = patternText.trim().split(/\s+/);
  if (want.length === 0 || argv.length === 0 || basename(argv[0] as string) !== want[0]) return false;
  let rest = argv.slice(1);
  let words = want.slice(1);
  if (want[0] === "git" && words[0] !== undefined && !words[0].startsWith("-")) {
    const at = gitSubcommandAt(argv);
    if (at < 0 || argv[at] !== words[0]) return false;
    rest = argv.slice(at + 1);
    words = words.slice(1);
  }
  return words.every((w) => rest.some((arg) => wordMatches(w, arg)));
}

const kindOf = (patternText: string): string => {
  const words = patternText.trim().split(/\s+/);
  // MetatorAI's own command: what it does is its last word (`metator review approve` → approve).
  if (words[0] === "metator" && words.length > 2) return words.at(-1) as string;
  return words[1] && !words[1].startsWith("-") ? words[1] : (words[0] as string);
};

/** What the config says about one command: never, ask (with what the consent is for), or allowed. */
export function guardCommand(argv: readonly string[], commands: GuardCommands): CommandVerdict {
  const never = commands.never.find((p) => matchesCommand(p, argv));
  if (never) return { level: "never", pattern: never };
  if (commands.allow.some((p) => matchesCommand(p, argv))) return { level: "allow" };
  const ask = commands.ask.find((p) => matchesCommand(p, argv));
  return ask ? { level: "ask", pattern: ask, kind: kindOf(ask) } : { level: "allow" };
}

/** The kinds the config asks consent for (`commit`, `push`, …). */
export const askKinds = (commands: GuardCommands): string[] => [...new Set(commands.ask.map(kindOf))];

/** Words before a request that are no part of it. */
const FILLER =
  /^(?:ok|okay|yes|yep|yeah|sure|please|now|then|so|just|go ahead|you can|you may|let's|lets|tak|dobra|dobrze|proszę|prosze|teraz|możesz|mozesz)\b[\s,]*/i;
/** Polish imperatives, by the English word of the command they ask for. */
const POLISH: Readonly<Record<string, RegExp>> = {
  commit: /^(?:zacommituj|zakomituj|scommituj|skomituj|commituj|komituj)\b/i,
  push: /^(?:wypchnij|pushnij|spushuj|zpushuj|pushuj)\b/i,
  merge: /^(?:zmerguj|merguj|scal)\b/i,
  rebase: /^(?:zrebasuj|rebasuj)\b/i,
};

/**
 * The guarded commands a person's message asks for in plain words ("commit it", "zacommituj",
 * "zrób commit i wypchnij"): the kinds, among those the config asks about. A request is a clause
 * that begins with the command's word; a refusal ("don't push"), a question, a noun ("the commit
 * handler") and a line MetatorAI typed (`[metator] …`, `metator: …`) consent to nothing.
 */
export function consentsIn(message: string, kinds: readonly string[]): string[] {
  const text = message.trim();
  if (/^\[metator\]|^metator:/i.test(text)) return [];
  const found: string[] = [];
  for (const raw of text.split(/[.,;!\n]| and | then | i | oraz | potem /i)) {
    let clause = raw.trim();
    if (clause === "" || clause.endsWith("?")) continue;
    for (let before = ""; before !== clause; ) {
      before = clause;
      clause = clause.replace(FILLER, "");
    }
    for (const kind of kinds) {
      const word = kind.replace(/[^a-z-]/gi, "");
      if (word === "") continue;
      const asked =
        new RegExp(`^${word}\\b`, "i").test(clause) ||
        new RegExp(`^(?:make|do|create|zrób|zrob|zrobić|zrobic) (?:a |the |an )?${word}\\b`, "i").test(
          clause,
        ) ||
        POLISH[word]?.test(clause) === true;
      if (asked && !found.includes(kind)) found.push(kind);
    }
  }
  return found;
}

/**
 * Copilot CLI's `--deny-tool` list from the same config: every `never` pattern as a shell prefix.
 * In prompt mode nobody can be asked, so a push the config asks about is denied there too.
 */
export function denyToolsOf(commands: GuardCommands, mode: { readonly headless: boolean }): string[] {
  const prefix = (p: string) => `shell(${p.replace(/\*+$/, "").trim()})`;
  return [
    ...commands.never.map(prefix),
    ...(mode.headless ? commands.ask.filter((p) => kindOf(p) === "push").map(prefix) : []),
  ];
}

/** "commit anyway": the person knows the commit holds debug changes and wants it all the same. */
export const commitsAnyway = (message: string): boolean =>
  /\b(anyway|all the same|regardless|with the debug)\b|mimo to|mimo wszystko|i tak\b|z debugiem/i.test(
    message,
  );

/** What a `git commit` in a command line would take, beyond what is staged when the line starts. */
export interface CommitReach {
  /** Every changed file git tracks: `commit -a`, `add -u`, `add -A`, `add .` at the root. */
  readonly tracked: boolean;
  /** New files too: `add -A`, `add .` at the root. */
  readonly untracked: boolean;
  /** Paths added before the commit or named on it, relative to the repository; a directory holds what is under it. */
  readonly paths: readonly string[];
}

/** The options of `git commit` that take the next word as their value. */
const COMMIT_VALUE_LONG = new Set([
  "--message",
  "--file",
  "--reuse-message",
  "--reedit-message",
  "--author",
  "--date",
  "--template",
  "--cleanup",
  "--fixup",
  "--squash",
  "--trailer",
  "--pathspec-from-file",
]);
const COMMIT_VALUE_SHORT = "mFCct";

/** A path as the repository names it; undefined outside the repository. */
function inRepository(path: string, cwd: string, root: string): string | undefined {
  const parts: string[] = [];
  for (const part of `${path.startsWith("/") ? "" : `${cwd}/`}${path}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const absolute = `/${parts.join("/")}`;
  const base = root.replace(/\/+$/, "");
  if (absolute === base) return "";
  return absolute.startsWith(`${base}/`) ? absolute.slice(base.length + 1) : undefined;
}

/**
 * Reads a whole command line (ADR-0094): a `git add <paths>` (or `-A`, `.`, `-u`, `git stage`)
 * before a `git commit` in the same call makes those files part of the commit, as do `commit -a`
 * and paths named on the commit; `cd` and `git -C` say where the paths are. Undefined when the
 * line commits nothing. A guard that looked only at what is staged before the call would miss
 * `git add x && git commit` in one call.
 */
export function commitReach(
  commands: readonly (readonly string[])[],
  where: { readonly root: string; readonly cwd?: string },
): CommitReach | undefined {
  type Reach = { tracked: boolean; untracked: boolean; paths: string[] };
  let cwd = where.cwd ?? where.root;
  const got: Reach = { tracked: false, untracked: false, paths: [] };
  // What `git add` put in the index so far in this line; it counts once a commit follows.
  let added: Reach = { tracked: false, untracked: false, paths: [] };
  let commits = false;
  const take = (path: string, dir: string, into: Reach) => {
    const rel = inRepository(path, dir, where.root);
    if (rel === undefined) return;
    if (rel === "") {
      into.tracked = true;
      into.untracked = true;
    } else if (!into.paths.includes(rel)) into.paths.push(rel);
  };
  for (const argv of commands) {
    const program = (argv[0] ?? "").split("/").pop();
    if (program === "cd" && argv[1] && !argv[1].startsWith("-")) {
      cwd = `/${inRepository(argv[1], cwd, "/") ?? ""}`;
      continue;
    }
    if (program !== "git") continue;
    const at = gitSubcommandAt(argv);
    if (at < 0) continue;
    // `git -C <dir>` works there.
    let dir = cwd;
    for (let i = 1; i < at; i++)
      if (argv[i] === "-C" && argv[i + 1]) dir = `/${inRepository(argv[i + 1] as string, dir, "/") ?? ""}`;
    const sub = argv[at];
    const rest = argv.slice(at + 1);
    if (sub === "add" || sub === "stage") {
      const named = rest.filter((a, i) => !a.startsWith("-") || rest.slice(0, i).includes("--"));
      const flags = rest.filter((a) => a.startsWith("-"));
      const all = flags.some((f) => f === "--all" || f === "--no-ignore-removal" || /^-[A-Za-z]*A/.test(f));
      const update = flags.some((f) => f === "--update" || /^-[A-Za-z]*u/.test(f));
      if (named.length === 0 && (all || update)) {
        added.tracked = true;
        if (all) added.untracked = true;
      }
      for (const path of named) take(path, dir, added);
    } else if (sub === "commit") {
      commits = true;
      got.tracked ||= added.tracked;
      got.untracked ||= added.untracked;
      for (const p of added.paths) if (!got.paths.includes(p)) got.paths.push(p);
      added = { tracked: false, untracked: false, paths: [] };
      for (let i = 0; i < rest.length; i++) {
        const word = rest[i] as string;
        if (word === "--") {
          for (const path of rest.slice(i + 1)) take(path, dir, got);
          break;
        }
        if (word === "--all") got.tracked = true;
        else if (word.startsWith("--")) {
          if (COMMIT_VALUE_LONG.has(word)) i++;
        } else if (word.startsWith("-") && word.length > 1) {
          // A cluster: `-a` takes the working tree; a letter that takes a value ends the cluster.
          const value = [...word.slice(1)].findIndex((c) => COMMIT_VALUE_SHORT.includes(c));
          const letters = value < 0 ? word.slice(1) : word.slice(1, value + 1);
          if (letters.includes("a")) got.tracked = true;
          if (value >= 0 && value === word.length - 2) i++;
        } else take(word, dir, got);
      }
    }
  }
  return commits ? got : undefined;
}
