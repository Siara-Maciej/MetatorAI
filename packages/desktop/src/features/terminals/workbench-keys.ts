/**
 * The Terminals' keys (S6): the prefix, then one chord that names a command of
 * `WORKBENCH_COMMANDS`; "Take the keyboard?" answered with Enter or Escape; copy mode's Escape and
 * `y`. The terminals' own keys are left alone otherwise, and a dialog has the keys while it is open.
 * The listener is in the capture phase: a focused xterm stops the keys it handles.
 */
import { useEffect } from "react";
import type { PaneView } from "../../shared/api/api.ts";
import { chordOf, type KeyMap } from "../../shared/model/keys.ts";
import { useLatest } from "../../shared/use-latest.ts";
import type { MenuItem } from "../../ui/context-menu.tsx";
import { actionOf, type WorkbenchTab } from "./model.ts";
import type { TerminalHandle } from "./terminal.tsx";

/** What the keys mean right now: one thing at a time. */
export type Mode =
  | { readonly kind: "none" }
  /** The prefix was pressed: the next chord is a command. */
  | { readonly kind: "prefix" }
  /** "Take the keyboard?" on a pane: Enter says yes, Escape no. */
  | { readonly kind: "ask"; readonly pane: string }
  | { readonly kind: "copy"; readonly pane: string }
  | { readonly kind: "goto" }
  | {
      readonly kind: "menu";
      readonly x: number;
      readonly y: number;
      readonly items: readonly MenuItem[];
      readonly label: string;
    };

export const IDLE: Mode = { kind: "none" };

export interface WorkbenchKeys {
  readonly mode: Mode;
  setMode(m: Mode | ((m: Mode) => Mode)): void;
  byKey(key: string | undefined): PaneView | undefined;
  readonly panes: readonly PaneView[];
  attach(p: PaneView): Promise<unknown>;
  readonly handles: { readonly current: Map<string, TerminalHandle> };
  say(text: string | undefined, tone?: "error" | "info"): void;
  readonly keymap: KeyMap;
  readonly commands: Readonly<Record<string, (p: PaneView | undefined, t: WorkbenchTab | undefined) => void>>;
  readonly focused: PaneView | undefined;
  readonly tab: WorkbenchTab | undefined;
}

export function useWorkbenchKeys(keys: WorkbenchKeys): void {
  const latest = useLatest(keys);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const { mode, setMode, byKey, panes, attach, handles, say, keymap, commands, focused, tab } =
        latest.current;
      const chord = chordOf(e);
      if (chord === "") return;
      // A dialog (the go-to picker, the help, the name) has the keys while it is open.
      if (mode.kind === "goto" || mode.kind === "menu" || document.querySelector("dialog[open]")) return;
      if (mode.kind === "ask") {
        if (chord === "enter") {
          const p = byKey(mode.pane) ?? panes.find((x) => x.id === mode.pane);
          setMode(IDLE);
          if (p) void attach(p);
        } else if (chord === "escape") setMode(IDLE);
        e.preventDefault();
        return;
      }
      if (mode.kind === "copy") {
        const h = handles.current.get(mode.pane);
        if (chord === "escape") {
          h?.clearSearch();
          setMode(IDLE);
          e.preventDefault();
        } else if (chord === "y" && !(e.target instanceof HTMLInputElement)) {
          const text = h?.copySelection();
          say(text ? `copied ${text.length} characters` : "nothing selected", "info");
          e.preventDefault();
        }
        return;
      }
      if (mode.kind === "none") {
        if (actionOf(keymap, chord, false) === "prefix") {
          e.preventDefault();
          e.stopPropagation();
          setMode({ kind: "prefix" });
          timer = setTimeout(() => setMode((m) => (m.kind === "prefix" ? IDLE : m)), 2000);
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setMode(IDLE);
      if (timer) clearTimeout(timer);
      const name = actionOf(keymap, chord, true);
      const command = name ? commands[name] : undefined;
      if (command) command(focused, tab);
      else say(name ? `${name}: not on this screen yet` : `no command for ${chord}`, "info");
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
