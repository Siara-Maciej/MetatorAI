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
]);

/** Readers whose first word (or each `-e` value) is a pattern, not a path. */
const SEARCHES = new Set(["grep", "egrep", "fgrep", "rg"]);

/** Options that make a reader write a file or run a program. */
const WRITES_OR_RUNS: Readonly<Record<string, RegExp>> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  rg: /^--pre(=|$)|^--search-zip$|^-z$/,
  sort: /^(-o|--output(=|$)|--compress-program(=|$))/,
};

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

export function readOnlyCommand(command: string, dirs: readonly string[]): boolean {
  // Substitutions, process substitution and several lines could run anything.
  if (/[`\n\r]|\$\(|<\(|>\(/.test(command)) return false;
  // Output thrown away or joined (`2>/dev/null`, `2>&1`) writes nothing: the only redirections allowed.
  const quiet = command
    .replace(/(^|\s)[12]?>>?\s*\/dev\/null(?=$|[\s;&|])/g, "$1")
    .replace(/(^|\s)[12]>&[12](?=$|[\s;&|])/g, "$1");
  let expanded = false;
  const tokens = parse(quiet, (key) => {
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
      if (metatorHelp(argv)) return true;
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
