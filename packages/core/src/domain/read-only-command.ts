import { parse } from "shell-quote";

/**
 * Commands that only read, for hosts whose agents search through the shell (a host without its
 * own search tools). A command qualifies only when every part of it does: a pipeline of the
 * programs below, without the options that write or run something, and with paths inside the
 * directories the agent works in. Anything else is not read-only and goes to a person.
 */
const READERS = new Set([
  "cd",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ls",
  "find",
  "cat",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "readlink",
  "realpath",
  "echo", // a separator between readers' output (`echo ---`); a redirection is refused anyway
]);

/** Readers whose first word (or each `-e` value) is a pattern, not a path. */
const SEARCHES = new Set(["grep", "egrep", "fgrep", "rg"]);

/** Options that make a reader write a file or run a program. */
const WRITES_OR_RUNS: Readonly<Record<string, RegExp>> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  rg: /^--pre(=|$)|^--search-zip$|^-z$/,
  sort: /^(-o|--output(=|$)|--compress-program(=|$))/,
};

/**
 * `sed -n '1,200p' file`: sed that only prints a range of lines. Any other script (a `w` writes a
 * file, an `e` runs a command) or option (`-i` edits in place) is not read-only.
 */
function sedPrint(argv: readonly string[], inside: (arg: string) => boolean): boolean {
  const [program, ...args] = argv;
  if (program !== "sed" || args[0] !== "-n" || args.length < 2) return false;
  const [script, ...files] = args.slice(1);
  return (
    /^(\d+|\$)(,(\d+|\$))?p(;(\d+|\$)(,(\d+|\$))?p)*$/.test(script as string) &&
    files.every((f) => !f.startsWith("-") && inside(f))
  );
}

/** git subcommands that only read the repository and print. */
const GIT_READS = new Set([
  "status",
  "log",
  "show",
  "diff",
  "rev-parse",
  "merge-base",
  "ls-files",
  "blame",
  "grep",
  "describe",
  "branch",
]);
/** `git branch` lists only with these options; any other (a name, `-d`, `-m`) changes branches. */
const BRANCH_LISTS = /^(--show-current|--list|-a|--all|-r|--remotes|-v|-vv|--verbose)$/;
/** Options that make a reading git command write a file or run a program. */
const GIT_WRITES_OR_RUNS = /^(--output(=|$)|--ext-diff$|--textconv$|-O|--open-files-in-pager(=|$))/;

/**
 * `git status`, `git log --oneline -5`, `git -C <dir> diff HEAD -- src`: git that only reads. Before
 * the subcommand only `-C <dir inside the directories>` and `--no-pager` (a `-c` sets config that
 * could run a program); after it, every word that is not a search pattern is checked as a path.
 */
function gitRead(argv: readonly string[], inside: (arg: string) => boolean): boolean {
  if (argv[0] !== "git") return false;
  let i = 1;
  for (; argv[i] === "-C" || argv[i] === "--no-pager"; i++) {
    if (argv[i] === "-C" && !inside(argv[++i] ?? "/")) return false;
  }
  const sub = argv[i] as string;
  const args = argv.slice(i + 1);
  if (!GIT_READS.has(sub) || args.some((a) => GIT_WRITES_OR_RUNS.test(a))) return false;
  if (sub === "branch" && !args.every((a) => BRANCH_LISTS.test(a))) return false;
  const patterns = new Set<number>();
  if (sub === "grep") {
    args.forEach((a, j) => {
      if (a === "-e") patterns.add(j + 1);
    });
    if (patterns.size === 0) patterns.add(args.findIndex((a) => !a.startsWith("-")));
  }
  return args.every((a, j) => patterns.has(j) || inside(a.includes("=") ? a.slice(a.indexOf("=") + 1) : a));
}

/** `metator …`, also as the repository runs it (`bun run metator …`, `npx metator …`). */
function asMetator(argv: readonly string[]): readonly string[] | undefined {
  if (argv[0] === "metator") return argv;
  if ((argv[0] === "npx" || argv[0] === "bunx") && argv[1] === "metator") return argv.slice(1);
  if (
    ["bun", "npm", "pnpm", "yarn"].includes(argv[0] as string) &&
    argv[1] === "run" &&
    argv[2] === "metator"
  )
    return argv.slice(2);
  return undefined;
}

/** MetatorAI commands that only read and print: what any agent may look up without asking. */
const METATOR_QUERIES = new Set([
  "symbols find",
  "graph deps",
  "graph dependents",
  "graph callers",
  "graph path",
  "graph cycles",
  "graph packages",
  "graph affected",
  "graph diff",
  "similar",
  "owners",
  "workspace list",
  "rules show",
  "rules pack",
  "rules lint",
  "review diff",
  "api diff",
  "system show",
  "system lint",
  "system impact",
  "system sources",
  "run status",
  "run activity",
  "run questions",
  "run list",
  "run schema",
  "run published",
  "config show",
  "changed",
  "findings schema",
  "findings check-quote",
  "findings validate",
  "plan lint",
  "plan schema",
  "arch cycles",
  "arch declared",
  "adr lint",
  "docs links",
  "docs inventory",
]);
/** Options that make a query write a file. */
const WRITING_OPTIONS = /^--(out|write|fix|save)(=|$)/;

/** `metator symbols find X`, `metator graph deps f`…: a query that reads and prints. */
function metatorQuery(argv: readonly string[]): boolean {
  const [program, ...rest] = argv;
  if (program !== "metator") return false;
  const words: string[] = [];
  for (const w of rest) {
    if (w.startsWith("-")) break;
    words.push(w);
  }
  const command = [2, 1].map((n) => words.slice(0, n).join(" ")).find((c) => METATOR_QUERIES.has(c));
  return command !== undefined && !rest.some((a) => WRITING_OPTIONS.test(a));
}

/** `metator help [command…]` or `metator <command…> --help`: help prints, it runs nothing. */
function metatorHelp(argv: readonly string[]): boolean {
  const [program, ...rest] = argv;
  if (program !== "metator" || rest.length === 0) return false;
  const last = rest.at(-1) as string;
  const words = rest.slice(0, -1);
  return (
    (rest[0] === "help" && rest.slice(1).every((w) => /^[a-z][a-z0-9-]*$/.test(w))) ||
    ((last === "--help" || last === "-h") && words.every((w) => /^[a-z][a-z0-9-]*$/.test(w)))
  );
}

/**
 * `NAME=word;` (or `&&`) at the start of a command: a word with nothing to quote, and nothing to
 * expand but names set before it (`R=/repo; D=$R/runs;`).
 */
const ASSIGNMENT = /^\s*([A-Za-z_]\w*)=((?:[^\s;&|$'"\\`(){}<>*?]|\$[A-Za-z_]\w*)+)\s*(?:;|&&)/;

export function readOnlyCommand(command: string, dirs: readonly string[]): boolean {
  // Substitutions, process substitution and several lines could run anything.
  if (/[`\n\r]|\$\(|<\(|>\(/.test(command)) return false;
  // Output thrown away or joined (`2>/dev/null`, `2>&1`) writes nothing: the only redirections allowed.
  const quiet = command
    .replace(/(^|\s)[12]?>>?\s*\/dev\/null(?=$|[\s;&|])/g, "$1")
    .replace(/(^|\s)[12]>&[12](?=$|[\s;&|])/g, "$1");
  // Plain names set up front (`R=.metator/runs/x; cat $R/plan.json`) stand for their words; the
  // words are then checked like any other.
  const vars = new Map<string, string>();
  let rest = quiet;
  for (let m = ASSIGNMENT.exec(rest); m; m = ASSIGNMENT.exec(rest)) {
    let unknown = false;
    const value = (m[2] as string).replace(/\$([A-Za-z_]\w*)/g, (_, name: string) => {
      const known = vars.get(name);
      if (known === undefined) unknown = true;
      return known ?? "";
    });
    if (unknown) return false;
    vars.set(m[1] as string, value);
    rest = rest.slice(m[0].length);
  }
  let expanded = false;
  const tokens = parse(rest, (key) => {
    const value = vars.get(key);
    if (value !== undefined) return value;
    // A lone `$` (a regular expression's end anchor) names no variable: it stays literal.
    if (key !== "") expanded = true;
    return `$${key}`;
  });
  if (expanded) return false;
  const commands: string[][] = [[]];
  for (const token of tokens) {
    if (typeof token === "string") (commands.at(-1) as string[]).push(token);
    else if ("op" in token && token.op === "glob") (commands.at(-1) as string[]).push(token.pattern);
    // A pipeline or a chain of readers reads, whichever runs: each part is checked on its own.
    else if ("op" in token && ["|", ";", "&&", "||"].includes(token.op)) commands.push([]);
    else return false; // a redirection to a file, `&`, a comment: not plain reading
  }
  const inside = (arg: string) =>
    !arg.split("/").includes("..") &&
    !arg.startsWith("~") &&
    (!arg.startsWith("/") || dirs.some((d) => arg === d || arg.startsWith(`${d.replace(/\/$/, "")}/`)));
  return (
    commands.filter((argv) => argv.length > 0).length > 0 &&
    commands.every((argv, i) => {
      if (argv.length === 0) return i === commands.length - 1 && i > 0; // a trailing `;`
      const metator = asMetator(argv);
      if (metator && (metatorHelp(metator) || metatorQuery(metator))) return true;
      if (sedPrint(argv, inside) || gitRead(argv, inside)) return true;
      const [program, ...args] = argv;
      if (!program || !READERS.has(program)) return false;
      const forbidden = WRITES_OR_RUNS[program];
      if (forbidden && args.some((a) => forbidden.test(a))) return false;
      // A search's pattern is not a path (`grep -rn "/api/offers" src`): every other word, and an
      // option's value (`--include=*.ts`), is checked as one.
      const patterns = new Set<number>();
      if (SEARCHES.has(program)) {
        args.forEach((a, i) => {
          if (a === "-e" || a === "--regexp") patterns.add(i + 1);
        });
        if (patterns.size === 0) {
          const first = args.findIndex((a) => !a.startsWith("-"));
          if (first >= 0) patterns.add(first);
        }
      }
      return args.every(
        (a, i) => patterns.has(i) || inside(a.includes("=") ? a.slice(a.indexOf("=") + 1) : a),
      );
    })
  );
}

/** A branch name to push: no option, no refspec (`:branch` deletes, `a:b` renames). */
const BRANCH = /^[A-Za-z0-9][\w./-]*$/;

/** What `git commit` may take: a message, all tracked changes, quiet. */
const COMMIT_OPTIONS = /^(-m|--message|-a|--all|-q|--quiet)$/;

/**
 * After a person approved the push (the delivery gate): staging, committing and pushing the run's
 * branch, nothing else that writes. `git add -A`, `git commit -m "<msg>"`, `git push -u origin
 * <branch>`, each alone or chained with `&&`, and any read-only part. Never a force push, an amend,
 * a skipped hook (`--no-verify`), a `-c` setting, or a path outside the directories.
 */
export function deliveryCommand(command: string, dirs: readonly string[]): boolean {
  // A commit message may span lines inside its quotes; a line break outside them starts a command.
  const unquoted = command.replace(/'[^']*'|"[^"\\]*"/g, "''");
  if (/[\n\r]/.test(unquoted) || /[`$]/.test(command)) return false;
  const parts: string[][] = [[]];
  for (const token of parse(command)) {
    if (typeof token === "string") (parts.at(-1) as string[]).push(token);
    else if ("op" in token && token.op === "&&") parts.push([]);
    else return false;
  }
  const inside = (arg: string) =>
    !arg.split("/").includes("..") &&
    !arg.startsWith("~") &&
    (!arg.startsWith("/") || dirs.some((d) => arg === d || arg.startsWith(`${d.replace(/\/$/, "")}/`)));
  const writes = (argv: readonly string[]): boolean => {
    const [git, sub, ...args] = argv;
    if (git !== "git") return false;
    if (sub === "add")
      return args.every((a) => a === "-A" || a === "--all" || (!a.startsWith("-") && inside(a)));
    if (sub === "commit") {
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as string;
        if (!COMMIT_OPTIONS.test(a)) return false;
        if (a === "-m" || a === "--message") i++; // the message is any text
      }
      return args.includes("-m") || args.includes("--message");
    }
    if (sub === "push") {
      const words = args.filter((a) => !/^(-u|--set-upstream|-q|--quiet)$/.test(a));
      return words.length === 2 && words[0] === "origin" && BRANCH.test(words[1] as string);
    }
    return false;
  };
  return (
    parts.every((p) => p.length > 0) &&
    parts.some(writes) &&
    parts.every((p) => writes(p) || readOnlyCommand(p.join(" "), dirs))
  );
}

/**
 * `cd <dir> && <command>` where the directory is one the agent works in and the command is one its
 * definition declares (`metator findings`): the same call without the `cd`, which agents add out of
 * habit. Only one `cd` and one command; anything else (another `&&`, a pipe, a substitution) is not.
 */
export function declaredAfterCd(
  command: string,
  declared: readonly string[],
  dirs: readonly string[],
): boolean {
  if (/[`\n\r;|<>]|\$\(/.test(command)) return false;
  const m = /^\s*cd\s+(\S+)\s*&&\s*(.+)$/.exec(command);
  if (!m) return false;
  const dir = (m[1] as string).replace(/\/$/, "");
  const rest = (m[2] as string).trim();
  if (rest.includes("&&")) return false;
  const inside =
    !dir.split("/").includes("..") &&
    dirs.some((d) => dir === d.replace(/\/$/, "") || dir.startsWith(`${d.replace(/\/$/, "")}/`));
  return inside && declared.some((p) => rest === p || rest.startsWith(`${p} `));
}
