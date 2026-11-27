/**
 * The workbench (S6, design/13 §5b; task-first since round 8): terminals over MetatorAI's runs.
 * A task's view shows its main terminal (where the person gave the task, else its conductor)
 * and one tile per repository session working on it, side by side; a session's own view shows
 * its conductor and its sub-terminals (workers), with "Task › repository" back. Ended panes stay,
 * read-only, with what ended them, until a person closes them. With no task chosen it lists the
 * tasks; "Workspaces" is the daemon's workspaces and tabs as before (shells, a new run's chat).
 * Everything else is a command: a key after the prefix, or an item of a right-click menu
 * (model.ts `WORKBENCH_COMMANDS`). The daemon owns the layout; this screen only draws and asks.
 *
 * The screen only lays its parts out (ADR-0113): what it keeps is the Terminals store (`state.ts`),
 * and each part reads only the value it draws.
 */

import { useEffect, useLayoutEffect } from "react";
import { useDaemonStore } from "../../shared/daemon/daemon.tsx";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { useLatest } from "../../shared/use-latest.ts";
import { useHostEditor } from "../repos/repos-context.tsx";
import { useNewChat } from "../threads/chat-actions.ts";
import { ByTaskView } from "./by-task-view.tsx";
import { Terminals, type TerminalsEnv, useTerminals, useTerminalsApi } from "./state.ts";
import { TabsView } from "./tabs-view.tsx";
import type { TerminalsRoute } from "./view.ts";
import { useWorkbenchKeys } from "./workbench-keys.ts";

export function WorkbenchScreen(route: TerminalsRoute) {
  const daemon = useDaemonStore();
  const newChat = useNewChat();
  const env = useLatest<TerminalsEnv>({ newChat: () => void newChat(), hostEditor: useHostEditor() });
  return (
    <ScopeProvider store={Terminals} init={{ daemon, route, env }}>
      <Follow {...route} />
      <View />
      {/* After the view: its terminals are ready (their effects ran) when this one looks for them. */}
      <ScrollTo />
    </ScopeProvider>
  );
}

/** The route, the daemon and the keys followed while the screen is open. */
function Follow({ task, session, group, showPane }: TerminalsRoute) {
  const api = useTerminalsApi();
  const daemon = useDaemonStore();
  useLayoutEffect(
    () => api.getState().routeTo({ task, session, group, showPane }),
    [api, task, session, group, showPane],
  );
  useEffect(() => api.getState().connect(), [api]);
  // Keys: the prefix, then one chord; the terminals' own keys are left alone otherwise.
  useWorkbenchKeys(api, daemon);
  return null;
}

/**
 * A terminal gone to from a link (↑ parent, ? asks, the tree, a new terminal's Show) is scrolled
 * to and gets the keyboard, once its tile is drawn.
 */
function ScrollTo() {
  const to = useTerminals((s) => s.scrollTo);
  const model = useTerminals((s) => s.model);
  const api = useTerminalsApi();
  useEffect(() => {
    void model;
    if (!to) return;
    const el = document.querySelector(`[data-tile="${CSS.escape(to)}"]`);
    if (!el) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    api.getState().handle(to)?.focus();
    api.getState().scrolled();
  }, [to, model, api]);
  return null;
}

function View() {
  const tabs = useTerminals((s) => s.model.view === "tabs");
  return tabs ? <TabsView /> : <ByTaskView />;
}
