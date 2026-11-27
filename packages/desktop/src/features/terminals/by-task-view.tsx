/**
 * The Terminals by task (round 8, round 22): the bar that says where you are, the filters, the tree
 * of every terminal and the tiles of a task, a session or every terminal at once. Each part reads
 * the value it draws from the screen's store (ADR-0113); the view only lays them out.
 */
import { type ReactNode, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Glyph } from "../../shared/components/glyph.tsx";
import { routeHash } from "../../shared/model/route.ts";
import { Button } from "../../ui/button.tsx";
import { DebugChanges } from "../runs/debug-changes.tsx";
import { PrefixChip, SettingsButton, useZoomKey, WorkbenchNotice, WorkbenchOverlays } from "./overlays.tsx";
import { type TerminalsState, useTerminals, useTerminalsApi } from "./state.ts";
import { RepoMark, TerminalFilters } from "./terminal-filters.tsx";
import { TerminalTree } from "./terminal-tree.tsx";
import { groupRows, passes, repoMark } from "./terminals.ts";
import { ContinueTaskButton, Tile } from "./tile.tsx";

export function ByTaskView() {
  const all = useTerminals((s) => s.model.view === "all");
  return (
    <section
      className="workbench by-task"
      aria-label="Terminals"
      data-testid="workbench"
      data-zoom-key={useZoomKey()}
    >
      <TerminalsBar />
      <WorkbenchNotice />
      <FilterBar />
      <TerminalsBody>
        <TerminalTree />
        {all ? <AllView /> : <TaskTiles />}
      </TerminalsBody>
      <FreshToast />
      <WorkbenchOverlays />
    </section>
  );
}

/** Where in Terminals: All terminals › the task › the session. */
export function TerminalsBar() {
  const task = useTerminals((s) => s.model.chosen?.runId);
  const title = useTerminals((s) => s.model.chosen?.title);
  const session = useTerminals((s) => s.model.session?.label);
  return (
    <nav className="terminals-bar" aria-label="where in Terminals" data-testid="terminals-bar">
      <a href={routeHash({ screen: "grid", group: "all" })} data-testid="terminals-all">
        All terminals
      </a>
      {task !== undefined ? (
        <>
          <span className="faint">›</span>
          {session !== undefined ? (
            <a href={routeHash({ screen: "grid", task })} data-testid="terminals-task" title={title}>
              {title}
            </a>
          ) : (
            <strong data-testid="terminals-task" title={title}>
              {title}
            </strong>
          )}
        </>
      ) : null}
      {session !== undefined ? (
        <>
          <span className="faint">›</span>
          <strong data-testid="terminals-session">{session}</strong>
        </>
      ) : null}
      <span className="spacer" />
      <ContinueTaskButton where="bar" />
      <TaskChanges />
      <CloseFinished />
      <a
        href={routeHash({ screen: "grid", group: "workspaces" })}
        title="every workspace and its tabs: shells, a new run's chat"
      >
        Workspaces
      </a>
      <PrefixChip />
      <SettingsButton />
    </nav>
  );
}

/** The task's repositories, each once. */
const taskRepos = (s: TerminalsState): (string | undefined)[] => {
  const c = s.model.chosen;
  return c ? [c.repo, ...c.sessions.map((x) => x.repo)].filter((r, i, all) => all.indexOf(r) === i) : [];
};

function TaskChanges() {
  const chosen = useTerminals((s) => s.model.chosen !== undefined);
  const repos = useTerminals(useShallow(taskRepos));
  return chosen ? <DebugChanges repos={repos} /> : null;
}

function CloseFinished() {
  const ended = useTerminals((s) => s.model.endedHere.length);
  const api = useTerminalsApi();
  return ended > 0 ? (
    <Button data-testid="close-finished" onClick={() => void api.getState().closeFinished()}>
      Close finished ({ended})
    </Button>
  ) : null;
}

export function FilterBar() {
  const all = useTerminals((s) => s.model.view === "all");
  const rows = useTerminals((s) => (s.model.view === "all" ? s.model.rows : s.model.viewRows));
  const filter = useTerminals((s) => s.filter);
  const grouping = useTerminals((s) => s.grouping);
  const known = useTerminals((s) => s.model.folderRepos);
  const setFilter = useTerminals((s) => s.setFilter);
  const setGrouping = useTerminals((s) => s.setGrouping);
  return (
    <TerminalFilters
      rows={rows}
      filter={filter}
      onFilter={setFilter}
      known={known}
      grouping={all ? grouping : undefined}
      onGrouping={all ? setGrouping : undefined}
    />
  );
}

/** The tree beside the tiles; folded narrow, kept by the window. */
function TerminalsBody({ children }: { readonly children: ReactNode }) {
  const narrow = useTerminals((s) => s.treeNarrow);
  return <div className={`terminals-body${narrow ? " tree-narrow" : ""}`}>{children}</div>;
}

/** The All view: the rows the filter lets through (or the zoomed one), grouped. */
function AllView() {
  const rows = useTerminals((s) => s.model.rows);
  const filter = useTerminals((s) => s.filter);
  const zoom = useTerminals((s) => s.zoom);
  const grouping = useTerminals((s) => s.grouping);
  const known = useTerminals((s) => s.model.folderRepos);
  const groups = useMemo(
    () =>
      groupRows(zoom ? rows.filter((r) => r.key === zoom) : rows.filter((r) => passes(r, filter)), grouping),
    [rows, filter, zoom, grouping],
  );
  const count = rows.length;
  return (
    <div className="all-terminals" data-testid="all-view">
      {groups.map((g) => (
        <section key={g.key} className="tgroup" data-testid={`group-${g.key}`}>
          <header className="ghead">
            {g.repo ? <RepoMark repo={g.repo} known={known} /> : null}
            {grouping === "state" ? <Glyph kind="pane" state={g.title} /> : null}
            <span className="gt">{g.title}</span>
            <span className="faint">
              {g.rows.length + (g.sessions ?? []).reduce((n, x) => n + x.rows.length, 0)}
            </span>
          </header>
          <Tiles keys={g.rows.map((r) => r.key)} />
          {(g.sessions ?? []).map((x) => (
            <section
              key={x.key}
              className="tgroup lane"
              style={{ "--lane": repoMark(x.repo ?? "", known).hue } as React.CSSProperties}
            >
              <header className="ghead">
                <RepoMark repo={x.repo ?? ""} known={known} />
                <span className="gt">{x.title}</span>
                <span className="faint">{x.rows.length}</span>
              </header>
              <Tiles keys={x.rows.map((r) => r.key)} />
            </section>
          ))}
        </section>
      ))}
      {groups.length === 0 ? (
        <div className="empty">
          {count === 0
            ? "No task has a terminal open. Shells and a new run's chat are under Workspaces."
            : `No terminal matches the filter: ${count} hidden.`}
        </div>
      ) : null}
    </div>
  );
}

function Tiles({ keys }: { readonly keys: readonly string[] }) {
  return keys.length > 0 ? (
    <div className="task-tiles flow">
      {keys.map((k) => (
        <Tile key={k} paneKey={k} />
      ))}
    </div>
  ) : null;
}

/** The tiles shown: the zoomed one, or every one the filter lets through. */
const shownKeys = (s: TerminalsState) => (s.zoom ? s.model.keys.filter((k) => k === s.zoom) : s.model.keys);

/** A task's or a session's tiles, side by side. */
export function TaskTiles() {
  const keys = useTerminals(useShallow(shownKeys));
  const view = useTerminals((s) => s.model.view);
  const held = useTerminals((s) => s.model.viewKeys.length);
  return (
    <div
      className={`task-tiles n${Math.min(Math.max(keys.length, 1), 3)}`}
      data-testid={view === "task" ? "task-view" : "session-view"}
    >
      {keys.map((k) => (
        <Tile key={k} paneKey={k} />
      ))}
      {keys.length === 0 ? (
        <div className="empty">
          {held > 0
            ? `No terminal of this ${view} matches the filter.`
            : `No terminal of this ${view === "task" ? "task" : "session"} is open.`}
        </div>
      ) : null}
    </div>
  );
}

/** A terminal that appeared while the screen is open (round 22): said with Show. */
function FreshToast() {
  const fresh = useTerminals((s) => s.freshToast);
  const parent = useTerminals((s) => s.model.rows.find((r) => r.key === s.freshToast?.parent)?.name);
  const hidden = useTerminals((s) => (s.freshToast ? !passes(s.freshToast, s.filter) : false));
  const api = useTerminalsApi();
  if (!fresh) return null;
  return (
    <output className="fresh-toast" data-testid="fresh-toast">
      <span>
        <b>New terminal</b> · {fresh.name} in {fresh.repo}
        {parent !== undefined ? ` · started by ${parent}` : ""}
        {hidden ? " · hidden by the filter" : ""}
      </span>
      <Button onClick={() => api.getState().showFresh()}>Show</Button>
      <Button variant="ghost" aria-label="dismiss" onClick={() => api.getState().closeFreshToast()}>
        ✕
      </Button>
    </output>
  );
}
