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
    /^(\d+|\$)(,(\d+|\$))?p$/.test(script as string) && files.every((f) => !f.startsWith("-") && inside(f))
  );
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
  "config show",
  "changed",
  "findings schema",
  "findings check-quote",
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

/** `metator help` or `metator <command…> --help`: help prints, it runs nothing. */
function metatorHelp(argv: readonly string[]): boolean {
  const [program, ...rest] = argv;
  if (program !== "metator" || rest.length === 0) return false;
  const last = rest.at(-1) as string;
  const words = rest.slice(0, -1);
  return (
    (rest.length === 1 && last === "help") ||
    ((last === "--help" || last === "-h") && words.every((w) => /^[a-z][a-z0-9-]*$/.test(w)))
  );
}

/** `NAME=word;` (or `&&`) at the start of a command: a word with nothing to expand or quote. */
const ASSIGNMENT = /^\s*([A-Za-z_]\w*)=([^\s;&|$'"\\`(){}<>*?]+)\s*(?:;|&&)/;

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
    vars.set(m[1] as string, m[2] as string);
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
      if (sedPrint(argv, inside)) return true;
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
