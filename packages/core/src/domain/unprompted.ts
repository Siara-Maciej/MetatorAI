import { parse, quote } from "shell-quote";
import { matchesAny } from "./glob.ts";
import { asMetator, readOnlyCommand } from "./read-only-command.ts";
import { resolvePath, shellQuotes } from "./shell-words.ts";

/**
 * What an agent may do without the host's approval prompt (ADR-0094, `guard.prompts: metator`):
 * MetatorAI's own commands, commands that only read, edits inside the repository, and the
 * repository's own checks. Decided here, once, for both hosts; the pre-tool hook answers `allow`
 * with the reason. `never` and `ask` are judged before this and win; everything this does not
 * name keeps the host's own prompt. A chain passes only when every part of it does.
 */
export interface Unprompted {
  /** The repository (or the run's worktree) the session works in, absolute. */
  readonly root: string;
  /** Where the shell stands; the root when the host does not say. */
  readonly cwd?: string;
  /** Other directories the agent works in (a run directory elsewhere): reading there is reading here. */
  readonly dirs?: readonly string[];
  /** `hosts.metatorCommand`: how this repository runs MetatorAI (`npx metator`, `bun run metator`). */
  readonly metatorCommand: string;
  /** What the gates' steps run (`gates.*[].run`): the repository's own checks. */
  readonly gates: readonly {
    readonly script?: string;
    readonly bin?: string;
    readonly args?: readonly string[];
    readonly workspaces?: string;
    readonly metator?: string;
    /** A Java build (`maven`, `gradle`) with its goals or tasks in `args`. */
    readonly build?: string;
  }[];
  /** The root package's scripts (`package.json`), by name. */
  readonly scripts: Readonly<Record<string, string>>;
}

/** The package scripts that are checks whatever the gates say. */
const CHECK_SCRIPTS = ["test", "typecheck", "lint", "build"];
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
/** What starts a binary of the repository: `npx tsc`, `bunx tsc`, `pnpm exec tsc`, `yarn tsc`. */
const RUNNERS: readonly (readonly string[])[] = [["npx"], ["bunx"], ["pnpm", "exec"], ["yarn"], ["bun", "x"]];

/**
 * MetatorAI's commands that record a person's decision or change what guards the agent: they
 * keep the host's prompt, so the person is the one who lets them run.
 */
const PERSONS: readonly (readonly string[])[] = [
  ["run", "approve"],
  ["run", "answer"],
  ["run", "resume"],
  ["run", "take"],
  ["run", "close"],
  ["system", "plan", "approve"],
  ["system", "plan", "retry"],
  ["arch", "plan", "approve"],
  ["scratch", "forget"],
  ["policy"],
  ["config", "set"],
  ["config", "unset"],
  ["issue", "add"],
  ["setup"],
  ["init"],
  ["generate"],
  ["agents"],
  ["serve"],
  ["mcp"],
  ["guard"],
  ["findings", "to-github"],
  ["mrs", "reply"],
  ["mrs", "resolve"],
  // Changes at a code host (ADR-0097): the person's word, also when an `ask` list leaves them out.
  ["mrs", "send"],
  ["review", "approve"],
];

/** The words after `metator` when the command is MetatorAI's, however the repository runs it. */
function metatorWords(
  argv: readonly string[],
  u: Pick<Unprompted, "metatorCommand">,
): readonly string[] | undefined {
  const own = parse(u.metatorCommand).filter((w): w is string => typeof w === "string");
  if (own.length > 0 && own.every((w, i) => argv[i] === w)) return argv.slice(own.length);
  return asMetator(argv)?.slice(1);
}

/**
 * The command of the person's that a MetatorAI command is (`run approve`), or undefined: their
 * decision, or the guard's own setup.
 */
export function personsCommand(words: readonly string[]): string | undefined {
  const named: string[] = [];
  for (const w of words) {
    if (w.startsWith("-")) break;
    named.push(w);
  }
  const person = PERSONS.find((p) => p.every((w, i) => named[i] === w));
  if (person) return person.join(" ");
  // The sentence that keeps a change quick is the person's own: an agent does not write it unasked.
  return named[0] === "quick" && named[1] === "start" && words.some((w) => /^--override(=|$)/.test(w))
    ? "quick start --override"
    : undefined;
}

/** The person's MetatorAI command a command line holds (`metator run approve`), if any. */
export function personsMetatorCommand(
  commands: readonly (readonly string[])[],
  u: Pick<Unprompted, "metatorCommand">,
): string | undefined {
  for (const argv of commands) {
    const words = metatorWords(argv, u);
    const person = words ? personsCommand(words) : undefined;
    if (person) return `metator ${person}`;
  }
  return undefined;
}

/** A path as an absolute one, from where the shell stands. */
const absolute = (path: string, base: string): string =>
  resolvePath(path.startsWith("/") ? path : `${base}/${path}`);

const within = (path: string, dirs: readonly string[]): boolean =>
  dirs.some((d) => {
    const dir = d.replace(/\/+$/, "");
    return path === dir || path.startsWith(`${dir}/`);
  });

/** Whether a command is one of the repository's own checks. */
function ownCheck(argv: readonly string[], u: Unprompted, base: string, dirs: readonly string[]): boolean {
  const names = new Set([
    ...CHECK_SCRIPTS.filter((s) => u.scripts[s] !== undefined),
    ...u.gates.flatMap((g) => [g.script, g.workspaces].filter((s): s is string => s !== undefined)),
  ]);
  // What follows the check's own words: flags, and paths inside the directories the agent works in.
  const extra = (rest: readonly string[]) =>
    rest.every((a) => a.startsWith("-") || (!a.startsWith("~") && within(absolute(a, base), dirs)));
  const [program, ...args] = argv;
  if (program && PACKAGE_MANAGERS.has(program)) {
    const name = args[0] === "run" ? args[1] : args[0];
    if (name !== undefined && names.has(name)) return extra(args.slice(args[0] === "run" ? 2 : 1));
  }
  const starts = (prefix: readonly string[]) =>
    prefix.length > 0 && prefix.every((w, i) => argv[i] === w) && extra(argv.slice(prefix.length));
  // The command a check script runs, typed as it is written (`bunx tsc --noEmit`).
  for (const name of names) {
    const script = u.scripts[name];
    if (script === undefined) continue;
    const words = parse(script);
    if (words.every((w): w is string => typeof w === "string") && starts(words)) return true;
  }
  // A Java build gate as the gate runs it, by its wrapper or the tool from PATH (`./mvnw -B test`).
  for (const gate of u.gates)
    if (gate.build !== undefined && buildCommands(gate.build, gate.args ?? []).some(starts)) return true;
  // A gate's binary with its arguments, alone or through the package manager's runner.
  for (const gate of u.gates) {
    if (gate.bin === undefined) continue;
    const declared = [gate.bin, ...(gate.args ?? [])];
    if (starts(declared) || starts([`node_modules/.bin/${gate.bin}`, ...(gate.args ?? [])])) return true;
    if (RUNNERS.some((r) => starts([...r, ...declared]))) return true;
  }
  return false;
}

/** `cmd <<'TAG'` … `TAG`: a quoted here-document, in which nothing expands. */
const HEREDOC = /^([^\n]*?)\s*<<-?\s*(['"])([A-Za-z_]\w*)\2[ \t]*\n[\s\S]*?\n\3[ \t]*\n?$/;

/**
 * Why a shell command needs no approval prompt, or undefined when the host is to ask. Every
 * part of a chain or a pipeline must be MetatorAI's own command (none of the person's), a
 * command that only reads, or one of the repository's own checks.
 */
export function unpromptedCommand(command: string, u: Unprompted): string | undefined {
  if (command.trim() === "") return undefined;
  const dirs = [u.root, ...(u.dirs ?? [])];
  const doc = HEREDOC.exec(command);
  const head = doc ? (doc[1] as string) : command;
  // A substitution or a second line could run anything.
  const { unquoted, substitutes } = shellQuotes(head);
  if (substitutes || /[\n\r]|<\(|>\(/.test(unquoted)) return undefined;
  // Output thrown away or joined writes nothing: the only redirections that pass.
  const quiet = head
    .replace(/(^|\s)[12]?>>?\s*\/dev\/null(?=$|[\s;&|])/g, "$1")
    .replace(/(^|\s)[12]>&[12](?=$|[\s;&|])/g, "$1");
  const parts: string[][] = [[]];
  for (const token of parse(quiet, (name) => `$${name}`)) {
    if (typeof token === "string") (parts.at(-1) as string[]).push(token);
    else if ("op" in token && token.op === "glob") (parts.at(-1) as string[]).push(token.pattern);
    else if ("op" in token && ["|", ";", "&&", "||"].includes(token.op)) parts.push([]);
    else return undefined; // a redirection to a file, `&`, a comment
  }
  if (parts.some((p) => p.length === 0)) return undefined;
  let base = absolute(u.cwd ?? u.root, "/");
  const kinds = new Set<"metator" | "check" | "read">();
  for (const argv of parts) {
    if (argv[0] === "cd" && argv.length === 2 && !(argv[1] as string).startsWith("~")) {
      const to = absolute(argv[1] as string, base);
      if (!within(to, dirs)) return undefined;
      base = to;
      continue;
    }
    const words = metatorWords(argv, u);
    if (words) {
      if (personsCommand(words)) return undefined;
      kinds.add("metator");
    } else if (ownCheck(argv, u, base, dirs)) kinds.add("check");
    else if (readOnlyCommand(`cd ${quote([base])} && ${quote(argv)}`, dirs)) kinds.add("read");
    else return undefined;
  }
  // A here-document feeds one MetatorAI command (`metator run write task.md <<'EOF'`), nothing else.
  if (doc && !(parts.length === 1 && kinds.has("metator"))) return undefined;
  if (kinds.size === 0) return undefined;
  if (kinds.size > 1) return "every part is MetatorAI's own, read-only or the repository's own check";
  return kinds.has("metator")
    ? "MetatorAI's own command"
    : kinds.has("check")
      ? "the repository's own check"
      : "it only reads";
}

/** Files an agent's edit never changes unasked: git's, the guard's own, MetatorAI's records. */
const KEEP_PROMPT = [
  ".git",
  ".git/**",
  "metator.config.yml",
  "metator.config.yaml",
  "metator.config.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".github/hooks/**",
];
/** What MetatorAI itself keeps in a run's directory: a run's artifacts are every other file there. */
const RUN_RECORDS =
  /^(state\.json|log\.md|handoff\.md|[^/]*\.jsonl|summary\.json|quick\.json|driver\.json|seen\.json|(questions|messages|work|review)(\/.*)?)$/;

/** Whether a file of a run directory (relative to it) is what MetatorAI keeps there, not an artifact. */
export const isRunRecord = (file: string): boolean => RUN_RECORDS.test(file.replaceAll("\\", "/"));

/**
 * Whether a path (absolute or relative, also through a run's worktree) names one of MetatorAI's
 * own records: a run's bookkeeping (state.json with its approvals, the questions with their
 * answers, the drive's lock, the log), a file `.metator/` keeps at its top (worktrees.json), a
 * person's consent, or a directory that holds them. MetatorAI's processes write them and decide
 * by them: an agent that wrote one could approve its own gate. A run's artifacts are not records.
 */
export function metatorRecord(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  const at = parts.lastIndexOf(".metator");
  if (at < 0) return false;
  const [top, run, ...file] = parts.slice(at + 1).filter((p) => p !== "" && p !== ".");
  if (top === undefined || top === "consents") return true;
  if (top === "runs") return run === undefined || file.length === 0 || isRunRecord(file.join("/"));
  return run === undefined && top.endsWith(".json");
}

/**
 * Why a file edit needs no approval prompt, or undefined when the host is to ask: every file is
 * inside the repository, and none is git's, the guard's own (the config, the hosts' hook files)
 * or one of MetatorAI's records. A run's artifacts (`.metator/runs/<id>/…`) are the agent's to
 * write. Secrets and a run's edit scope are judged before this.
 */
export function unpromptedEdit(paths: readonly string[], u: Unprompted): string | undefined {
  if (paths.length === 0) return undefined;
  const root = u.root.replace(/\/+$/, "");
  for (const path of paths) {
    const at = absolute(path.replaceAll("\\", "/"), u.cwd ?? u.root);
    if (!at.startsWith(`${root}/`)) return undefined;
    const rel = at.slice(root.length + 1);
    if (matchesAny(rel, KEEP_PROMPT)) return undefined;
    if (rel === ".metator" || rel.startsWith(".metator/")) {
      if (!/^\.metator\/runs\/[^/]+\/./.test(rel) || metatorRecord(rel)) return undefined;
    }
  }
  return "an edit inside the repository";
}

/**
 * MetatorAI command prefixes under which there is no command of the person's: what a host that
 * takes an allow list up front is given (Copilot CLI's `--allow-tool`, which matches by prefix
 * and cannot be told "except `run approve`"). A group that holds a person's command is listed
 * by its other subcommands; what is not here is asked about by that host.
 */
export const UNPROMPTED_METATOR: readonly string[] = [
  "graph",
  "symbols",
  "cards",
  "similar",
  // Reading a Java repository (round 22): every `metator java` command only reads (its index is a cache).
  "java",
  "rules",
  "workflow",
  "ask",
  "session",
  "test",
  "gate",
  "plan",
  // Not `review` as a whole: `review approve` is the person's (ADR-0097).
  "review metadata",
  "review diff",
  "review plan",
  "review changes",
  "review notes",
  "review open",
  "review list",
  "review show",
  "review check",
  "review finding",
  "review rereview",
  "review watch",
  "review unwatch",
  "review publish",
  "status",
  "inbox",
  "changed",
  "owners",
  "run status",
  "run new",
  "run start",
  "run delegate",
  "run wait",
  "run collect",
  "run workers",
  "run result",
  "run advance",
  "run ask",
  "run write",
  "run schema",
  "run list",
  "run activity",
  "run questions",
  "run message",
  "run messages",
  "run published",
  "quick check",
  "quick fit",
  "quick ready",
  "quick reviewed",
  "scratch begin",
  "scratch end",
  "scratch list",
  "scratch drop",
  "system show",
  "system lint",
  "system impact",
  "system analyze",
  "issue list",
  "issue show",
  "issue propose",
  // A thread's chat reads and keeps its thread (ADR-0095): no command of the group is the person's.
  "thread",
];

/**
 * The allow list for a host that needs one before it starts (ADR-0094): MetatorAI's commands
 * of `UNPROMPTED_METATOR` as this repository runs them, and the repository's checks (its gates'
 * scripts and `test`, `typecheck`, `lint`, `build`) through each package manager. Reads and edits
 * are not listed: a prefix cannot say "inside the repository"; the pre-tool hook answers those.
 */
export function allowToolsOf(u: Pick<Unprompted, "metatorCommand" | "gates">): string[] {
  const scripts = [
    ...new Set([
      ...CHECK_SCRIPTS,
      ...u.gates.flatMap((g) => [g.script, g.workspaces].filter((s): s is string => s !== undefined)),
    ]),
  ];
  const builds = u.gates.flatMap((g) =>
    g.build === undefined ? [] : buildCommands(g.build, g.args ?? []).map((c) => `shell(${c.join(" ")})`),
  );
  return [
    ...UNPROMPTED_METATOR.map((prefix) => `shell(${u.metatorCommand} ${prefix})`),
    ...[...PACKAGE_MANAGERS].flatMap((pm) => scripts.map((s) => `shell(${pm} run ${s})`)),
    ...[...PACKAGE_MANAGERS].map((pm) => `shell(${pm} test)`),
    ...new Set(builds),
  ];
}

/** How a person or an agent types a Java build gate: through the wrapper, or the tool from PATH. */
function buildCommands(build: string, args: readonly string[]): string[][] {
  // On Windows the wrapper is `mvnw.cmd` (`gradlew.bat`), found in the folder the shell stands in.
  if (build === "maven")
    return [
      ["./mvnw", ...args],
      ["mvnw.cmd", ...args],
      ["mvn", ...args],
    ];
  if (build === "gradle")
    return [
      ["./gradlew", ...args],
      ["gradlew.bat", ...args],
      ["gradle", ...args],
    ];
  return [];
}
