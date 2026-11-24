/**
 * The shell's keys (`SHELL_KEYS`): `?` the help, `n` a new chat, `g` the next run that waits; on
 * Home, j/k and the arrows move along the queue, `g` is the next decision and `o` its run's
 * overview. Escape closes the drawer; while a dialog is open the keys are its own.
 */
import { useEffect } from "react";
import { useOpenRun } from "../features/runs/open-run.ts";
import { useNewChat } from "../features/threads/chat-actions.ts";
import { useDaemon } from "../shared/daemon/daemon.tsx";
import { plainKey } from "../shared/model/keys.ts";
import { type NeedRow, stepNeed } from "../shared/model/needs.ts";
import type { Route } from "../shared/model/route.ts";
import { navigate } from "../shared/navigation.ts";
import { openHelp } from "../shared/overlays.ts";
import { useLatest } from "../shared/use-latest.ts";
import { nextWaiting } from "./model.ts";

export function useShellKeys(
  route: Route,
  needs: readonly NeedRow[],
  picked: NeedRow | undefined,
  closeDrawer: () => void,
) {
  const { runs } = useDaemon("runs");
  const newChat = useNewChat();
  const openRun = useOpenRun();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeDrawer();
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    const key = plainKey(e);
    if (key === "?") {
      // The key opens the help; it is not the first letter of its filter.
      e.preventDefault();
      openHelp();
    }
    if (key === "n") void newChat();
    if (route.screen === "inbox") {
      const step =
        key === "j" || key === "ArrowDown" || key === "g" ? 1 : key === "k" || key === "ArrowUp" ? -1 : 0;
      const next = step === 0 ? undefined : stepNeed(needs, route.pick, step);
      if (next) {
        e.preventDefault();
        navigate({ screen: "inbox", pick: next.key });
      }
      if (key === "o" && picked?.runId) navigate({ screen: "run", runId: picked.runId, tab: "overview" });
    } else if (key === "g") {
      const next = nextWaiting(runs, route.screen === "run" ? route.runId : undefined);
      if (next) openRun(next.runId, false, next.terminalAsk);
    }
  };
  const handler = useLatest(onKey);
  useEffect(() => {
    const listen = (e: KeyboardEvent) => handler.current(e);
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, []);
}
