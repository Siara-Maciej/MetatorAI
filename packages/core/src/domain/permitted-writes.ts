import { parse } from "shell-quote";
import { readOnlyCommand } from "./read-only-command.ts";
import { resolvePath, shellQuotes } from "./shell-words.ts";

/** A run's branch (`metator/<run id>`), by name or as the target of `HEAD:`. */
const RUN_BRANCH = /^(HEAD:(refs\/heads\/)?)?metator\/[A-Za-z0-9][\w.-]*$/;

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
  const { unquoted, expands } = shellQuotes(command);
  if (/[\n\r]/.test(unquoted) || expands) return false;
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
    // `git -C <the worktree> add -A`: the same command, aimed at a directory the agent works in.
    const at = argv[1] === "-C" ? 3 : 1;
    if (at === 3 && !(inside(argv[2] ?? "/") && argv[2] !== undefined)) return false;
    const [git] = argv;
    const [sub, ...args] = argv.slice(at);
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
      return words.length === 2 && words[0] === "origin" && RUN_BRANCH.test(words[1] as string);
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
 * `rm [-f] <file>…` where every file is inside the given directories (the run's isolated worktree,
 * the run directory): the same files Edit and Write may change there without asking. No `-r`, no
 * glob, no `..`, nothing chained.
 */
export function removeInside(command: string, dirs: readonly string[], cwd: string): boolean {
  const { unquoted, expands } = shellQuotes(command);
  if (expands || /[;&|<>*?[\]{}~\n\r]/.test(unquoted)) return false;
  const words = command.trim().split(/\s+/);
  if (words[0] !== "rm") return false;
  const files = words.slice(1).filter((w) => w !== "-f");
  if (files.length === 0 || files.some((f) => f.startsWith("-") || f.split("/").includes(".."))) return false;
  return files.every((f) => {
    const abs = resolvePath(f.startsWith("/") ? f : `${cwd}/${f}`);
    return dirs.some((d) => abs.startsWith(`${resolvePath(d)}/`));
  });
}

/**
 * Writing a run's own artifact through the shell, as some agents do instead of their Write tool:
 * `mkdir -p <dir>`, `cat > <file> <<'EOF' … EOF` (a quoted here-document, nothing expands), or the
 * two joined by `&&` or `;`. Every path must be inside the run directory (`runDirs`: as given and
 * where it really is), the same files the Write tool may write there without asking.
 */
export function runArtifactWrite(command: string, runDirs: readonly string[], cwd: string): boolean {
  const doc = /^([\s\S]*?)<<-?\s*(['"])([A-Za-z_]\w*)\2[ \t]*\n[\s\S]*?\n\3[ \t]*\n?$/.exec(command);
  const head = doc ? (doc[1] as string) : command;
  if (/[`\n\r|<]|\$/.test(head)) return false;
  const parts = head
    .split(/&&|;/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return false;
  const inRun = (path: string) => {
    const abs = path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
    return (
      !abs.split("/").includes("..") &&
      runDirs.some((d) => abs === d.replace(/\/$/, "") || abs.startsWith(`${d.replace(/\/$/, "")}/`))
    );
  };
  let writes = 0;
  for (const [i, part] of parts.entries()) {
    const mkdir = /^mkdir\s+-p\s+(\S+)$/.exec(part);
    if (mkdir) {
      if (!inRun(mkdir[1] as string)) return false;
      continue;
    }
    // Only the last part may take the here-document, and only `cat > <file>` takes one.
    const cat = /^cat\s*>\s*(\S+)$/.exec(part);
    if (!cat || !doc || i !== parts.length - 1 || !inRun(cat[1] as string)) return false;
    writes++;
  }
  return writes === 1 || (!doc && writes === 0);
}
