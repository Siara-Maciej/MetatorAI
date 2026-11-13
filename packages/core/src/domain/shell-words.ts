/** An absolute path with `.` and `..` folded (`/a/b/../c` is `/a/c`). */
export function resolvePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * The command with each quoted span emptied, and whether the shell would expand or substitute
 * anything in it: `$` or a backtick outside single quotes and not escaped. Inside single quotes
 * both are literal.
 */
export function shellQuotes(command: string): {
  readonly unquoted: string;
  /** `$` that would expand: a variable, a substitution. */
  readonly expands: boolean;
  /** A command substitution: `$(` or a backtick. */
  readonly substitutes: boolean;
} {
  let unquoted = "";
  let expands = false;
  let substitutes = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote === "'") {
      if (c === "'") quote = undefined;
    } else if (c === "\\") {
      i++; // an escaped character is literal
      if (!quote) unquoted += "_";
    } else if (c === "$" || c === "`") {
      expands = true;
      if (c === "`" || command[i + 1] === "(") substitutes = true;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
      unquoted += "''";
    } else unquoted += c;
  }
  return { unquoted, expands, substitutes };
}
