/**
 * One pane of the Terminals, read from the screen's store (ADR-0113): its frame draws again only
 * when its own pane, whether it is the focused one, its question or its copy mode changed, so
 * focusing another pane draws two frames, not the screen.
 */
import { memo } from "react";
import { paneNeedsYou } from "../../shared/model/needs.ts";
import { paneStateOf } from "../../shared/model/panes.ts";
import { PaneFrame } from "./pane-frame.tsx";
import {
  focusKeyOf,
  useTerminals,
  useTerminalsApi,
  useTerminalsDaemon,
  useTerminalsOption,
} from "./state.ts";
import { paneAt } from "./view.ts";

export const PaneSlot = memo(function PaneSlot({ paneKey }: { readonly paneKey: string }) {
  const api = useTerminalsApi();
  const p = useTerminals((s) => paneAt(s.model, paneKey));
  const focused = useTerminals((s) => focusKeyOf(s) === paneKey);
  const asking = useTerminals((s) => s.mode.kind === "ask" && s.mode.pane === paneKey);
  const copying = useTerminals((s) => s.mode.kind === "copy" && s.mode.pane === paneKey);
  const inTab = useTerminals((s) => s.model.view === "tabs");
  const alone = useTerminals((s) => s.model.keys.length === 1);
  const repo = useTerminals((s) => p?.repo ?? s.model.repoName);
  // The person holds the keyboard of the pane's run.
  const mine = useTerminalsDaemon((d) => {
    const run = d.run(p?.runId, repo);
    return run?.driver === "human" && run.attachedBy === d.me && d.me !== "";
  });
  const asks = useTerminalsDaemon((d) => (p ? paneNeedsYou({ id: p.id, repo }, d.paneAsks) : false));
  const borders = useTerminalsOption<"auto" | "always" | "off">("ui.paneBorders", "auto");
  const labels = useTerminalsOption("ui.paneLabels", true);
  const symbols = useTerminalsOption<"dots" | "symbols">("ui.statusIndicators", "symbols") === "symbols";
  const scrollback = useTerminalsOption("terminal.scrollbackLines", 5000);
  if (!p) return <div className="empty">pane {paneKey}</div>;
  const state = paneStateOf(p);
  const s = () => api.getState();
  return (
    <PaneFrame
      pane={p}
      state={state}
      repo={repo}
      focused={focused}
      // A task's tiles have their own border and head: their frames draw none.
      framed={inTab && (borders === "always" || (borders === "auto" && !alone))}
      labels={labels}
      symbols={symbols}
      mine={mine}
      // A shell takes anyone's keys; an agent's pane of a run only its attached person's.
      canType={!p.runId || p.role === "shell" || mine}
      scrollback={scrollback}
      asking={asking}
      copying={copying}
      lastOfTab={inTab && alone}
      needsYou={asks || state === "asks"}
      onFocus={() => s().focusOn(paneKey)}
      onMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        s().openMenu({ x: e.clientX, y: e.clientY }, ["pane"], p, s().model.tab, `pane ${p.id}`);
      }}
      onZoom={() => s().toggleZoom(paneKey)}
      onBlockedKey={() => s().blockedKey(p)}
      onReady={(h) => s().setHandle(paneKey, h)}
      onRetry={() => void s().retryPane(p)}
      onContinue={() => void s().continuePane(p)}
      onClose={() => s().closeFrame(p)}
    />
  );
});
