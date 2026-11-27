/**
 * The small parts both Terminals views share (ADR-0113): the question toast, the right-click menu,
 * the go-to picker, what the last action answered, the prefix chip and the settings button. Each
 * reads only the value it draws.
 */
import { keyMapOf } from "../../shared/model/keys.ts";
import { notifies } from "../../shared/model/needs.ts";
import { navigate } from "../../shared/navigation.ts";
import { Button } from "../../ui/button.tsx";
import { ContextMenu } from "../../ui/context-menu.tsx";
import { Notice } from "../../ui/notice.tsx";
import { GotoPicker } from "./goto.tsx";
import { toastOf } from "./model.ts";
import { QuestionToast } from "./question-toast.tsx";
import { IDLE, useTerminals, useTerminalsApi, useTerminalsDaemon } from "./state.ts";

/** One key of the window's keymap (`keys.*` options), e.g. the zoom's first chord. */
function useKeyOf(action: string): string | undefined {
  return useTerminalsDaemon((d) => keyMapOf(d.options)[action]?.[0]);
}

export const useZoomKey = (): string | undefined => useKeyOf("zoom");

export function WorkbenchOverlays() {
  return (
    <>
      <Toast />
      <Menu />
      <Goto />
    </>
  );
}

/**
 * One toast: the newest question of the tabs shown here (notify.channel app) that the person has
 * not closed.
 */
function Toast() {
  const inbox = useTerminalsDaemon((d) => d.inbox);
  const announce = useTerminalsDaemon((d) => notifies(d.options));
  const repos = useTerminals((s) => s.model.repos);
  const dismissed = useTerminals((s) => s.dismissed);
  const api = useTerminalsApi();
  const toast = toastOf(inbox, repos, dismissed, announce);
  return toast ? (
    <QuestionToast
      item={toast}
      onOpen={() => api.getState().openToast(toast)}
      onDismiss={() => api.getState().dismissToast(`${toast.runId}/${toast.question.id}`)}
    />
  ) : null;
}

function Menu() {
  const mode = useTerminals((s) => (s.mode.kind === "menu" ? s.mode : undefined));
  const setMode = useTerminals((s) => s.setMode);
  return mode ? (
    <ContextMenu at={mode} items={mode.items} label={mode.label} onClose={() => setMode(IDLE)} />
  ) : null;
}

function Goto() {
  const open = useTerminals((s) => s.mode.kind === "goto");
  const repos = useTerminals((s) => s.model.repos);
  const panes = useTerminals((s) => s.model.panes);
  const taskRows = useTerminals((s) => s.model.gotoTaskRows);
  const api = useTerminalsApi();
  return open ? (
    <GotoPicker
      repos={repos}
      panes={panes}
      taskRows={taskRows}
      onPick={(row) => api.getState().pick(row)}
      onClose={() => api.getState().setMode(IDLE)}
    />
  ) : null;
}

/** What the last action answered: it stays until closed (D5). */
export function WorkbenchNotice() {
  const notice = useTerminals((s) => s.notice);
  const closeNotice = useTerminals((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.text ? notice.tone : "info"} onClose={closeNotice} />;
}

/** The prefix was pressed: the next chord is a command. */
export function PrefixChip() {
  const on = useTerminals((s) => s.mode.kind === "prefix");
  const prefix = useKeyOf("prefix");
  return on ? (
    <span className="chip teal" data-testid="prefix">
      {prefix ?? "prefix"} …
    </span>
  ) : null;
}

export function SettingsButton() {
  return (
    <Button
      variant="ghost"
      onClick={() => navigate({ screen: "settings" })}
      title="settings"
      aria-label="settings"
    >
      ⚙
    </Button>
  );
}
