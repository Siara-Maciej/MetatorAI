/**
 * The keys of the app: the key map from the options, a key as the person reads it, the help's rows.
 */
import type { PaneView, ResolvedOption } from "../api/api.ts";

/** A keyboard event as a chord the options spell: `ctrl+b`, `shift+enter`, `[`, `f5`. */
export function chordOf(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
): string {
  const named: Record<string, string> = {
    " ": "space",
    Enter: "enter",
    Escape: "escape",
    Tab: "tab",
    Backspace: "backspace",
    Delete: "delete",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
  };
  const key = named[e.key] ?? e.key.toLowerCase();
  if (["control", "alt", "shift", "meta"].includes(key)) return "";
  const mods = [
    e.ctrlKey ? "ctrl" : "",
    e.altKey ? "alt" : "",
    e.shiftKey && key.length > 1 ? "shift" : "",
    e.metaKey ? "meta" : "",
  ].filter((m) => m !== "");
  return [...mods, key].join("+");
}
/** The keymap: action → chords, from the `keys.*` options (`prefix+z` means after the prefix). */
export type KeyMap = Readonly<Record<string, readonly string[]>>;
/** The registry's defaults (`keys.*`), so the keys work before the options arrive from the daemon. */
export const DEFAULT_KEYS: KeyMap = {
  prefix: ["ctrl+b"],
  newShell: ["prefix+c"],
  newTab: ["prefix+t"],
  splitRight: ["prefix+v"],
  splitDown: ["prefix+-"],
  zoom: ["prefix+z"],
  focusLeft: ["prefix+h", "prefix+left"],
  focusDown: ["prefix+j", "prefix+down"],
  focusUp: ["prefix+k", "prefix+up"],
  focusRight: ["prefix+l", "prefix+right"],
  goto: ["prefix+g"],
  nextWaiting: ["prefix+n"],
  attach: ["prefix+a"],
  release: ["prefix+escape"],
  copyMode: ["prefix+["],
  closePane: ["prefix+x"],
  plan: ["prefix+p"],
  changes: ["prefix+r"],
  backlog: ["prefix+b"],
  help: ["prefix+?"],
};
/** The keymap from the options; the defaults where the options say nothing (or are not here yet). */
export const keyMapOf = (options: readonly Pick<ResolvedOption, "key" | "value">[]): KeyMap => ({
  ...DEFAULT_KEYS,
  ...Object.fromEntries(
    options
      .filter((o) => o.key.startsWith("keys.") && Array.isArray(o.value))
      .map((o) => [o.key.slice("keys.".length), (o.value as string[]).map((c) => c.toLowerCase())]),
  ),
});
/**
 * What a chord does: with the prefix pressed before, the actions bound to `prefix+<chord>`;
 * without, the ones bound to the bare chord (the prefix itself is `prefix`).
 */
/**
 * The keys of an action as a person presses them: `prefix+c` reads `ctrl+b then c` (the prefix key
 * first, then the letter). Undefined when the action has no key.
 */
export function keyText(map: KeyMap, action: string): string | undefined {
  const chord = map[action]?.[0];
  if (!chord?.startsWith("prefix+")) return chord;
  return `${map.prefix?.[0] ?? "the prefix key"} then ${chord.slice("prefix+".length)}`;
}
/* ---------- keys, answers, hosts, repositories: the small decisions every screen shares ---------- */

/**
 * The key of a single-letter shortcut (D7): the bare key, or nothing when Ctrl, Cmd or Alt is
 * held (the browser's and the system's own chords) or the person is typing in a field.
 */
export function plainKey(e: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly target: unknown;
}): string | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName ?? "") || t.isContentEditable === true))
    return undefined;
  return e.key;
}
/** What a workbench command can see when it says its label and whether it applies. */
export interface CommandContext {
  /** The pane the command is about: the focused one, or the one under the menu. */
  readonly pane?:
    | { readonly runId?: string | undefined; readonly role: PaneView["role"]; readonly asks: boolean }
    | undefined;
  /** The person holds the keyboard of that pane's run. */
  readonly attached: boolean;
  /** Someone else holds it. */
  readonly taken: boolean;
  readonly zoomed: boolean;
  readonly tab?:
    | { readonly kind: "task" | "shell"; readonly runId?: string | undefined; readonly panes: number }
    | undefined;
}
export interface WorkbenchCommand {
  /** The action's name: the `keys.<id>` option binds it. */
  readonly id: string;
  /** What the help and the menus call it. */
  label(ctx: CommandContext): string;
  /** The menus that list it, in this table's order. */
  readonly menu?: "pane" | "tab" | "tab-own" | undefined;
  /** A thin line above it in a menu. */
  readonly separator?: boolean | undefined;
  enabled?(ctx: CommandContext): boolean;
  /** Only listed when it applies (the two keyboard commands swap). */
  shown?(ctx: CommandContext): boolean;
}
const hasRun = (c: CommandContext) => c.pane?.runId !== undefined;
/**
 * Every command of the workbench, once: the keys run them (`keys.*`), the right-click menus list
 * the ones with a `menu`, and the help overlay lists them all with their keys.
 */
export const WORKBENCH_COMMANDS: readonly WorkbenchCommand[] = [
  {
    id: "attach",
    label: (c) => (c.pane?.asks ? "Answer here (take the keyboard)" : "Take the keyboard"),
    menu: "pane",
    shown: (c) => hasRun(c) && !c.attached,
    enabled: (c) => hasRun(c) && !c.taken,
  },
  {
    id: "release",
    label: () => "Give the keyboard back",
    menu: "pane",
    shown: (c) => !hasRun(c) || c.attached,
    enabled: hasRun,
  },
  { id: "zoom", label: (c) => (c.zoomed ? "Unzoom" : "Zoom"), menu: "pane" },
  { id: "splitRight", label: () => "Split right", menu: "pane" },
  { id: "splitDown", label: () => "Split down", menu: "pane" },
  { id: "copyMode", label: () => "Copy mode", menu: "pane" },
  { id: "plan", label: () => "Plan of the run", menu: "pane", separator: true, enabled: hasRun },
  { id: "changes", label: () => "Changes", menu: "pane", enabled: hasRun },
  { id: "editor", label: () => "Open in editor", menu: "pane" },
  { id: "taskFromHere", label: () => "New task from here…", menu: "pane" },
  {
    id: "closePane",
    label: () => "Close pane",
    menu: "pane",
    separator: true,
    enabled: (c) => c.pane?.role !== "conductor",
  },
  { id: "newShellTab", label: () => "New tab: shell", menu: "tab" },
  { id: "newTab", label: () => "New chat with the agent…", menu: "tab" },
  { id: "backlog", label: () => "Backlog…", menu: "tab" },
  { id: "newShell", label: () => "New shell pane here", menu: "tab-own", separator: true },
  {
    id: "closeTab",
    label: (c) => (c.tab?.kind === "task" ? "Close tab (its panes; the worktree stays)" : "Close tab"),
    menu: "tab-own",
    enabled: (c) => !(c.tab?.kind === "shell" && c.tab.panes === 0),
  },
  { id: "focusLeft", label: () => "Focus the pane before (left)" },
  { id: "focusRight", label: () => "Focus the pane after (right)" },
  { id: "focusUp", label: () => "Focus the pane before (up)" },
  { id: "focusDown", label: () => "Focus the pane after (down)" },
  { id: "goto", label: () => "Go to a pane or a question" },
  { id: "nextWaiting", label: () => "Next tab that waits for you" },
  { id: "help", label: () => "This help" },
];
const NO_CONTEXT: CommandContext = { attached: false, taken: false, zoomed: false };
/** A chord as a person presses it: `prefix+z` reads `ctrl+b z`; a bare chord reads as it is. */
export const chordText = (map: KeyMap, chord: string): string =>
  chord.startsWith("prefix+") ? `${map.prefix?.[0] ?? "prefix"} ${chord.slice("prefix+".length)}` : chord;
/** The first key of an action as a person presses it (`ctrl+b z`), for a menu item; none when unbound. */
export const keyLabel = (map: KeyMap, action: string): string | undefined => {
  const chord = map[action]?.[0];
  return chord === undefined ? undefined : chordText(map, chord);
};
/** A key that works on every screen, outside a field. */
export const SHELL_KEYS: readonly { readonly keys: string; readonly label: string }[] = [
  { keys: "?", label: "This help" },
  { keys: "g", label: "Next run that needs you" },
  { keys: "n", label: "New chat with the agent" },
  { keys: "j / k  ↓ / ↑", label: "Home: the next or the previous decision; elsewhere, move in a list" },
  { keys: "↵", label: "Decision: send the chosen answer" },
  { keys: "o", label: "Overview of the run (from a decision, or on a run)" },
  { keys: "t / d / l", label: "Step: its terminal, changes, activity" },
  { keys: "⌫ / esc", label: "Board: back from a task's board to all tasks" },
  { keys: "a / c", label: "Run: attach to its session / release it to the agent" },
  { keys: "e", label: "Run: open in the editor" },
  { keys: "esc", label: "Close a dialog, a menu or the runs drawer" },
];
/** The rows of the help that hold the words: a key or what it does, ignoring case. */
export function filterKeys<K extends { readonly keys: string; readonly label: string }>(
  rows: readonly K[],
  query: string,
): K[] {
  const q = query.trim().toLowerCase();
  return q === "" ? [...rows] : rows.filter((r) => `${r.keys} ${r.label}`.toLowerCase().includes(q));
}
/**
 * The help overlay's rows for the workbench: every bound command with all its keys as they are
 * pressed, in the table's order; a command with no key is left out.
 */
export function helpRows(
  map: KeyMap,
): { readonly id: string; readonly keys: string; readonly label: string }[] {
  const rows = [
    { id: "prefix", keys: (map.prefix ?? []).join(" / "), label: "The prefix: press it, then a key below" },
    ...WORKBENCH_COMMANDS.map((c) => ({
      id: c.id,
      keys: (map[c.id] ?? []).map((chord) => chordText(map, chord)).join(" / "),
      label: c.label(NO_CONTEXT),
    })),
  ];
  return rows.filter((r) => r.keys !== "");
}
