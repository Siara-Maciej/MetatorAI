/**
 * Editors `metator ui` can open a worktree in (F8.6, ADR-0054). Terminal editors take over this
 * terminal until they exit; the others open their own window and return at once.
 */
export interface KnownEditor {
  readonly command: string;
  readonly label: string;
  readonly terminal: boolean;
}

export const KNOWN_EDITORS: readonly KnownEditor[] = [
  { command: "code", label: "VS Code", terminal: false },
  { command: "cursor", label: "Cursor", terminal: false },
  { command: "windsurf", label: "Windsurf", terminal: false },
  { command: "zed", label: "Zed", terminal: false },
  { command: "idea", label: "IntelliJ IDEA", terminal: false },
  { command: "webstorm", label: "WebStorm", terminal: false },
  { command: "subl", label: "Sublime Text", terminal: false },
  { command: "nvim", label: "Neovim", terminal: true },
  { command: "vim", label: "Vim", terminal: true },
  { command: "hx", label: "Helix", terminal: true },
  { command: "nano", label: "nano", terminal: true },
  { command: "emacs", label: "Emacs", terminal: true },
];

/** How to open `path` with an editor command such as "code" or "code --new-window". */
export function editorLaunch(
  editor: string,
  path: string,
): { readonly argv: string[]; readonly attached: boolean } {
  const words = editor.trim().split(/\s+/);
  const base = (words[0] ?? "").split("/").pop() ?? "";
  const known = KNOWN_EDITORS.find((e) => e.command === base);
  return { argv: [...words, path], attached: known?.terminal ?? false };
}

/** The editor to use: the config, then $VISUAL, then $EDITOR; undefined means ask. */
export function preferredEditor(
  configured: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return configured || env.VISUAL || env.EDITOR || undefined;
}

/** Editors that take `--goto file:line` and `-r` (reuse the window): VS Code and its forks. */
const GOTO_EDITORS = new Set(["code", "code-insiders", "cursor", "windsurf"]);

/**
 * The command that opens a directory, or a file at a line, in the editor (S5): VS Code and its
 * forks get the directory, then `--goto file:line`; other editors get the file (or the directory).
 * `reuse` adds `-r` for the VS Code family, so one window follows the run.
 */
export function editorArgv(
  editor: string,
  target: { readonly dir: string; readonly file?: string; readonly line?: number; readonly reuse?: boolean },
): string[] {
  const words = editor
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  const base = (words[0] ?? "").split("/").pop() ?? "";
  const file = target.file ? `${target.dir}/${target.file}` : undefined;
  if (GOTO_EDITORS.has(base))
    return [
      ...words,
      ...(target.reuse ? ["-r"] : []),
      target.dir,
      ...(file ? ["--goto", `${file}${target.line ? `:${target.line}` : ""}`] : []),
    ];
  if (!file) return [...words, target.dir];
  const known = KNOWN_EDITORS.find((e) => e.command === base);
  return known?.terminal && target.line ? [...words, `+${target.line}`, file] : [...words, file];
}
