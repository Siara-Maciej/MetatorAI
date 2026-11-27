/**
 * The Terminals' keys (S6): the prefix, then one chord that names a command of
 * `WORKBENCH_COMMANDS`; "Take the keyboard?" answered with Enter or Escape; copy mode's Escape and
 * `y`. The terminals' own keys are left alone otherwise, and a dialog has the keys while it is open.
 * The listener is in the capture phase: a focused xterm stops the keys it handles. It reads the
 * screen's store and the daemon's options at the moment of the key (ADR-0113).
 */
import { useEffect } from "react";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { chordOf, keyMapOf } from "../../shared/model/keys.ts";
import type { StoreApi } from "../../shared/state/scoped-store.ts";
import { actionOf } from "./model.ts";
import { focusedOf, IDLE, paneById, type TerminalsState } from "./state.ts";
import { paneAt } from "./view.ts";

export function useWorkbenchKeys(
  api: StoreApi<TerminalsState>,
  daemon: Store<Pick<Daemon, "options">>,
): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const s = api.getState();
      const { mode, setMode, say } = s;
      const chord = chordOf(e);
      if (chord === "") return;
      // A dialog (the go-to picker, the help, the name) has the keys while it is open.
      if (mode.kind === "goto" || mode.kind === "menu" || document.querySelector("dialog[open]")) return;
      if (mode.kind === "ask") {
        if (chord === "enter") {
          const p = paneAt(s.model, mode.pane) ?? paneById(s, mode.pane);
          setMode(IDLE);
          if (p) void s.attach(p);
        } else if (chord === "escape") setMode(IDLE);
        e.preventDefault();
        return;
      }
      if (mode.kind === "copy") {
        const h = s.handle(mode.pane);
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
      const keymap = keyMapOf(daemon.getState().options);
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
      const ran = name ? s.command(name, focusedOf(s), s.model.tab) : false;
      if (!ran) say(name ? `${name}: not on this screen yet` : `no command for ${chord}`, "info");
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (timer) clearTimeout(timer);
    };
  }, [api, daemon]);
}
