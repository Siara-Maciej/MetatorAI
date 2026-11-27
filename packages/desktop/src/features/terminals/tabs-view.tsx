/**
 * The workspaces' tabs ("Workspaces", S6): the tab bar of the chosen workspace, the strip with its
 * run's stages, and its panes laid out by the tab's split tree. Each part reads the value it draws
 * from the screen's store (ADR-0113).
 */
import { Glyph } from "../../shared/components/glyph.tsx";
import { RepoSelect } from "../../shared/components/repo-select.tsx";
import { StageBar } from "../../shared/components/stage-bar.tsx";
import { keyMapOf, keyText } from "../../shared/model/keys.ts";
import { routeHash } from "../../shared/model/route.ts";
import { Button } from "../../ui/button.tsx";
import { Tabs } from "../../ui/tabs.tsx";
import { needsPerson, type WorkbenchTab } from "./model.ts";
import { PrefixChip, SettingsButton, useZoomKey, WorkbenchNotice, WorkbenchOverlays } from "./overlays.tsx";
import { PaneSlot } from "./pane-slot.tsx";
import { SplitGrid } from "./split-grid.tsx";
import { focusedOf, useTerminals, useTerminalsApi, useTerminalsDaemon } from "./state.ts";

export function TabsView() {
  return (
    <section
      className="workbench"
      aria-label="Terminals"
      data-testid="workbench"
      data-zoom-key={useZoomKey()}
    >
      <TabBar />
      <ProcStrip />
      <div className="body">
        <section className="grid-area" aria-label="panes">
          <WorkbenchNotice />
          <PaneGrid />
        </section>
      </div>
      <WorkbenchOverlays />
    </section>
  );
}

function TabBar() {
  const repos = useTerminals((s) => s.model.repos);
  const repo = useTerminals((s) => s.model.repo);
  const current = useTerminals((s) => s.model.tab?.key);
  const hasTasks = useTerminals((s) => s.model.tasks.length > 0);
  const api = useTerminalsApi();
  const tabMenu = (e: React.MouseEvent, t: WorkbenchTab | undefined) => {
    e.preventDefault();
    e.stopPropagation();
    api
      .getState()
      .openMenu(
        { x: e.clientX, y: e.clientY },
        t ? ["tab", "tab-own"] : ["tab"],
        undefined,
        t,
        t ? `tab ${t.label}` : "tabs",
      );
  };
  return (
    <Tabs
      label="tabs"
      className="tabbar"
      before={
        repos.length > 1 ? (
          <select
            className="workspace"
            aria-label="workspace"
            title="The workspace whose tabs are shown: the checkout, or the agents that start runs"
            value={repo?.id ?? ""}
            onChange={(e) => api.getState().chooseRepo(e.target.value)}
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
                {r.attention && needsPerson({ attention: r.attention }) ? " · needs you" : ""}
              </option>
            ))}
          </select>
        ) : undefined
      }
      current={current}
      onSelect={(key) => api.getState().chooseTab(key)}
      items={(repo?.tabs ?? []).map((t) => ({
        id: t.key,
        title: t.label,
        onContextMenu: (e: React.MouseEvent) => tabMenu(e, t),
        label: (
          <>
            <Glyph kind="attention" state={t.attention} />
            <span className="name">{t.label}</span>
            {t.branch ? <span className="faint branch"> {t.branch}</span> : null}
          </>
        ),
      }))}
    >
      <Button className="plus" onClick={(e) => tabMenu(e, undefined)} aria-label="new tab">
        +
      </Button>
      <span className="spacer" />
      {hasTasks ? (
        <a href={routeHash({ screen: "grid", group: "all" })} data-testid="by-task">
          All terminals ›
        </a>
      ) : null}
      <RepoSelect />
      <PrefixChip />
      <SettingsButton />
    </Tabs>
  );
}

/** The tab's run: its stages, what waits for you, its worktree and the editor. */
function ProcStrip() {
  const tab = useTerminals((s) => s.model.tab);
  const api = useTerminalsApi();
  const run = tab?.run;
  return (
    <div className="procstrip" data-testid="procstrip">
      {run && run.stages.length > 0 ? (
        <StageBar
          stages={run.stages}
          variant="strip"
          onOpen={() => api.getState().command("plan", undefined, tab)}
        />
      ) : (
        <span className="faint">
          {tab?.kind === "shell" ? "No run in this tab: a shell, or the agent that starts one" : "No tab"}
        </span>
      )}
      <span className="spacer" />
      {run && run.questions.length > 0 ? <span className="amber">? asks {run.questions.length}</span> : null}
      {run && needsPerson(run) && run.questions.length === 0 ? (
        <span className="amber">{run.attention === "escalated" ? "escalated" : "asks in its terminal"}</span>
      ) : null}
      {tab?.worktree ? <span className="faint mono">{tab.worktree}</span> : null}
      {tab ? (
        <Button
          variant="ghost"
          onClick={() => {
            const s = api.getState();
            s.command("editor", tab.runId ? undefined : focusedOf(s), tab);
          }}
          title="open in your editor (editor.command)"
          data-testid="open-editor"
        >
          editor
        </Button>
      ) : null}
    </div>
  );
}

/** The tab's panes by its split tree; a zoomed pane fills the area. */
function PaneGrid() {
  const tree = useTerminals((s) => s.model.tree);
  const zoom = useTerminals((s) => s.zoom);
  const hasTab = useTerminals((s) => s.model.tab !== undefined);
  const options = useTerminalsDaemon((d) => d.options);
  const api = useTerminalsApi();
  if (tree)
    return (
      <SplitGrid
        tree={tree}
        zoom={zoom}
        renderPane={(key) => <PaneSlot paneKey={key} />}
        onResize={(t) => api.getState().resize(t)}
      />
    );
  const keymap = keyMapOf(options);
  return (
    <div className="empty">
      <h2>{hasTab ? "No pane in this tab" : "No tab"}</h2>
      <p>
        {keyText(keymap, "newShell") ?? "The tab bar's menu"} opens a shell here;{" "}
        {keyText(keymap, "newTab") ?? "+ New chat"} opens a chat with the agent that starts a task;
        right-click the tab bar for the menu; ? lists every key.
      </p>
    </div>
  );
}
