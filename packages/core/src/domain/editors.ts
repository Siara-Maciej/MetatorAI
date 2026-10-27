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
