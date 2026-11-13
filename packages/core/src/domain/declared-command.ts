import { shellQuotes } from "./shell-words.ts";

/**
 * One command of the given prefixes (`metator findings`) and nothing chained to it: no `;`, `&&`,
 * `|`, redirection, line break or substitution outside quotes.
 */
export function singleDeclaredCommand(command: string, declared: readonly string[]): boolean {
  const { unquoted, substitutes } = shellQuotes(command);
  if (substitutes || /[;&|<>\n\r]/.test(unquoted)) return false;
  const trimmed = command.trim();
  return declared.some((d) => trimmed === d || trimmed.startsWith(`${d} `));
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

/**
 * `<declared command> <<'EOF' … EOF`: a command the agent's definition declares, fed a quoted
 * here-document (nothing in it expands), as `metator run write task.md` reads its artifact from
 * stdin. One command; the line before the document has no chain, pipe, redirection or substitution.
 */
export function declaredWithDocument(command: string, declared: readonly string[]): boolean {
  const m = /^\s*([^\n]*?)\s*<<-?\s*(['"])([A-Za-z_]\w*)\2[ \t]*\n[\s\S]*?\n\3[ \t]*\n?$/.exec(command);
  if (!m) return false;
  const head = (m[1] as string).trim();
  if (/[`;|&<>]|\$/.test(head)) return false;
  return declared.some((p) => head === p || head.startsWith(`${p} `));
}
