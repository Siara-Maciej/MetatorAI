/**
 * Every terminal as a tree (round 22), beside the tiles: task → main terminal → sessions →
 * sub-terminals, each with its repository's mark and its state. A terminal the filter hides stays
 * in the tree, dimmed, so nothing goes missing; a click shows it (the filter opens just enough).
 * Each node reads its own facts from the screen's store (ADR-0113): focusing a terminal draws the
 * two nodes that changed.
 */

import { useShallow } from "zustand/react/shallow";
import { Glyph } from "../../shared/components/glyph.tsx";
import { paneLabel } from "../../shared/model/panes.ts";
import { Button } from "../../ui/button.tsx";
import { focusKeyOf, type TerminalsState, useTerminals, useTerminalsApi } from "./state.ts";
import { RepoMark } from "./terminal-filters.tsx";
import { passes, rowsBelow, type TerminalRow } from "./terminals.ts";

/** The tasks of the rows, in their order: their run ids. */
const taskIds = (s: TerminalsState): string[] => [...new Set(s.model.rows.map((r) => r.task.runId))];

export function TerminalTree() {
  const narrow = useTerminals((s) => s.treeNarrow);
  const tasks = useTerminals(useShallow(taskIds));
  const count = useTerminals((s) => s.model.rows.length);
  if (narrow)
    return (
      <nav className="terminal-tree narrow" aria-label="every terminal" data-testid="terminal-tree">
        <TreeFold narrow />
        {tasks.map((id) => (
          <NarrowTask key={id} runId={id} />
        ))}
      </nav>
    );
  return (
    <nav className="terminal-tree" aria-label="every terminal" data-testid="terminal-tree">
      <div className="tree-head">
        <span className="faint">Terminals · {count}</span>
        <TreeFold narrow={false} />
      </div>
      {tasks.map((id) => (
        <WideTask key={id} runId={id} />
      ))}
    </nav>
  );
}

function TreeFold({ narrow }: { readonly narrow: boolean }) {
  const setTreeNarrow = useTerminals((s) => s.setTreeNarrow);
  return (
    <Button
      variant="ghost"
      className="tree-fold"
      data-testid="tree-fold"
      aria-label={narrow ? "Expand the tree" : "Collapse the tree"}
      title={narrow ? "Expand the tree of terminals" : "Collapse the tree to its marks"}
      aria-expanded={!narrow}
      onClick={() => setTreeNarrow(!narrow)}
    >
      {narrow ? "»" : "«"}
    </Button>
  );
}

const rowsOfTask = (s: TerminalsState, runId: string) => s.model.rows.filter((r) => r.task.runId === runId);
const titleOf = (s: TerminalsState, runId: string) => rowsOfTask(s, runId)[0]?.task.title ?? "";

function NarrowTask({ runId }: { readonly runId: string }) {
  const title = useTerminals((s) => titleOf(s, runId));
  const keys = useTerminals(useShallow((s: TerminalsState) => rowsOfTask(s, runId).map((r) => r.key)));
  return (
    <div className="ttask" title={title}>
      <hr />
      {keys.map((k) => (
        <TreeNode key={k} rowKey={k} narrow />
      ))}
    </div>
  );
}

function WideTask({ runId }: { readonly runId: string }) {
  const title = useTerminals((s) => titleOf(s, runId));
  const keys = useTerminals(useShallow((s: TerminalsState) => rowsOfTask(s, runId).map((r) => r.key)));
  const shut = useTerminals((s) => keys.length > 0 && keys.every((k) => s.filter.panes.includes(k)));
  const taskEye = useTerminals((s) => s.taskEye);
  return (
    <div className="ttask">
      <div className="ttitle trow" title={title}>
        <span className="name">{title}</span>
        <span className="faint">{keys.length}</span>
        <Eye
          shut={shut}
          what={`every terminal of ${title}`}
          testId={`eye-task-${runId}`}
          onClick={() => taskEye(runId)}
        />
      </div>
      {keys.map((k) => (
        <TreeNode key={k} rowKey={k} narrow={false} />
      ))}
    </div>
  );
}

/** How deep a row sits under its task's main terminal. */
function depthOf(rows: readonly TerminalRow[], r: TerminalRow): number {
  let depth = 0;
  let parent = r.parent;
  while (parent !== undefined && depth < 8) {
    depth++;
    parent = rows.find((x) => x.key === parent)?.parent;
  }
  return depth;
}

/** What a node draws, as values: it draws again only when one of them changed. */
function nodeFacts(s: TerminalsState, key: string) {
  const rows = s.model.rows;
  const r = rows.find((x) => x.key === key);
  const n = r ? rowsBelow(rows, r.key).length : 0;
  return {
    found: r !== undefined,
    repo: r?.repo ?? "",
    role: r?.role,
    state: r?.state ?? "",
    task: r?.task.title ?? "",
    name: r?.name ?? "",
    label: !r
      ? ""
      : r.role === "conductor"
        ? r.repo
        : r.name === "main terminal"
          ? r.name
          : paneLabel(r.pane),
    depth: r ? depthOf(rows, r) : 0,
    children: rows.filter((x) => x.parent === key).length,
    what: r && n > 0 ? `${r.name} and the ${n} terminal${n === 1 ? "" : "s"} below it` : (r?.name ?? ""),
    passes: r ? passes(r, s.filter) : true,
    shut: s.filter.panes.includes(key),
    focus: focusKeyOf(s) === key,
    fresh: s.fresh.includes(key),
  };
}

export function TreeNode({ rowKey: key, narrow }: { readonly rowKey: string; readonly narrow: boolean }) {
  const f = useTerminals(useShallow((s: TerminalsState) => nodeFacts(s, key)));
  const known = useTerminals((s) => s.model.folderRepos);
  const api = useTerminalsApi();
  if (!f.found) return null;
  const className = `tnode${f.passes ? "" : " hidden"}${f.focus ? " focus" : ""}${f.fresh ? " fresh" : ""}`;
  const pick = () => api.getState().goTo(key, true);
  if (narrow)
    return (
      <Button
        className={className}
        title={`${f.task} › ${f.name} · ${f.repo} · ${f.state}`}
        aria-label={`${f.name} in ${f.repo}, ${f.state}`}
        data-testid={`tree-${key}`}
        onClick={pick}
      >
        <RepoMark repo={f.repo} known={known} />
        <Glyph kind="pane" state={f.state} />
      </Button>
    );
  return (
    <div className={`trow${f.shut ? " shut" : ""}`}>
      <Button
        className={className}
        style={{ paddingLeft: `${6 + f.depth * 12}px` }}
        title={`${f.repo} · ${f.role} · ${f.state}${
          f.shut ? " (hidden: a click shows it)" : f.passes ? "" : " (hidden by the filter)"
        }`}
        data-testid={`tree-${key}`}
        onClick={pick}
      >
        <RepoMark repo={f.repo} known={known} />
        <span className="name">{f.label}</span>
        {f.fresh ? <span className="new">new</span> : null}
        <span className="end">
          <Glyph kind="pane" state={f.state} />
          {f.children > 0 ? <span className="faint"> {f.children}</span> : null}
        </span>
      </Button>
      <Eye shut={f.shut} what={f.what} testId={`eye-${key}`} onClick={() => api.getState().eye(key)} />
    </div>
  );
}

/**
 * The eye of a tree row (round 22): shown while the row is hovered or focused, and always while
 * what it hides is hidden (struck through). A click hides or shows.
 */
function Eye({
  shut,
  what,
  testId,
  onClick,
}: {
  readonly shut: boolean;
  readonly what: string;
  readonly testId: string;
  onClick(): void;
}) {
  const label = `${shut ? "Show" : "Hide"} ${what}`;
  return (
    <Button
      className={`ghost teye${shut ? " shut" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={shut}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="8" r="2.2" fill="currentColor" />
        {shut ? <path d="M2 14 14 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /> : null}
      </svg>
    </Button>
  );
}
