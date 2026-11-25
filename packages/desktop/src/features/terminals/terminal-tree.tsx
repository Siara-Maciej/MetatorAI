/**
 * Every terminal as a tree (round 22), beside the tiles: task → main terminal → sessions →
 * sub-terminals, each with its repository's mark and its state. A terminal the filter hides stays
 * in the tree, dimmed, so nothing goes missing; a click shows it (the filter opens just enough).
 */

import { Glyph } from "../../shared/components/glyph.tsx";
import { paneLabel } from "../../shared/model/panes.ts";
import { Button } from "../../ui/button.tsx";
import { RepoMark } from "./terminal-filters.tsx";
import { passes, rowsBelow, type TerminalFilter, type TerminalRow } from "./terminals.ts";

export function TerminalTree({
  rows,
  filter,
  focused,
  fresh,
  onPick,
  known,
  narrow,
  onNarrow,
  onEye,
  onTaskEye,
}: {
  /** The eye on a terminal: it and the terminals below it hidden, or shown again. */
  onEye(key: string): void;
  /** The eye on a task's title: every terminal of the task hidden, or shown again. */
  onTaskEye(runId: string): void;
  /** Folded to its narrow version: a column of marks and states, each named on hover. */
  readonly narrow: boolean;
  onNarrow(narrow: boolean): void;
  /** The folder's repositories: they take distinct hues (`repoMark`). */
  readonly known: readonly string[];
  readonly rows: readonly TerminalRow[];
  readonly filter: TerminalFilter;
  /** The key of the focused terminal. */
  readonly focused?: string | undefined;
  /** Terminals that appeared a moment ago: marked new. */
  readonly fresh: ReadonlySet<string>;
  onPick(key: string): void;
}) {
  const depthOf = (r: TerminalRow): number => {
    let depth = 0;
    let parent = r.parent;
    while (parent !== undefined && depth < 8) {
      depth++;
      parent = rows.find((x) => x.key === parent)?.parent;
    }
    return depth;
  };
  const tasks = [...new Set(rows.map((r) => r.task))];
  const whatOf = (r: TerminalRow) => {
    const n = rowsBelow(rows, r.key).length;
    return n > 0 ? `${r.name} and the ${n} terminal${n === 1 ? "" : "s"} below it` : r.name;
  };
  const fold = (
    <Button
      variant="ghost"
      className="tree-fold"
      data-testid="tree-fold"
      aria-label={narrow ? "Expand the tree" : "Collapse the tree"}
      title={narrow ? "Expand the tree of terminals" : "Collapse the tree to its marks"}
      aria-expanded={!narrow}
      onClick={() => onNarrow(!narrow)}
    >
      {narrow ? "»" : "«"}
    </Button>
  );
  const classOf = (r: TerminalRow, base: string) =>
    `${base}${passes(r, filter) ? "" : " hidden"}${focused === r.key ? " focus" : ""}${fresh.has(r.key) ? " fresh" : ""}`;
  if (narrow)
    return (
      <nav className="terminal-tree narrow" aria-label="every terminal" data-testid="terminal-tree">
        {fold}
        {tasks.map((t) => (
          <div key={t.runId} className="ttask" title={t.title}>
            <hr />
            {rows
              .filter((r) => r.task === t)
              .map((r) => (
                <Button
                  key={r.key}
                  className={classOf(r, "tnode")}
                  title={`${t.title} › ${r.name} · ${r.repo} · ${r.state}`}
                  aria-label={`${r.name} in ${r.repo}, ${r.state}`}
                  data-testid={`tree-${r.key}`}
                  onClick={() => onPick(r.key)}
                >
                  <RepoMark repo={r.repo} known={known} />
                  <Glyph kind="pane" state={r.state} />
                </Button>
              ))}
          </div>
        ))}
      </nav>
    );
  return (
    <nav className="terminal-tree" aria-label="every terminal" data-testid="terminal-tree">
      <div className="tree-head">
        <span className="faint">Terminals · {rows.length}</span>
        {fold}
      </div>
      {tasks.map((t) => {
        const own = rows.filter((r) => r.task === t);
        return (
          <div key={t.runId} className="ttask">
            <div className="ttitle trow" title={t.title}>
              <span className="name">{t.title}</span>
              <span className="faint">{own.length}</span>
              <Eye
                shut={own.length > 0 && own.every((r) => filter.panes.includes(r.key))}
                what={`every terminal of ${t.title}`}
                testId={`eye-task-${t.runId}`}
                onClick={() => onTaskEye(t.runId)}
              />
            </div>
            {own.map((r) => {
              const below = rows.filter((x) => x.parent === r.key).length;
              const eyeShut = filter.panes.includes(r.key);
              return (
                <div key={r.key} className={`trow${eyeShut ? " shut" : ""}`}>
                  <Button
                    className={classOf(r, "tnode")}
                    style={{ paddingLeft: `${6 + depthOf(r) * 12}px` }}
                    title={`${r.repo} · ${r.role} · ${r.state}${
                      eyeShut
                        ? " (hidden: a click shows it)"
                        : passes(r, filter)
                          ? ""
                          : " (hidden by the filter)"
                    }`}
                    data-testid={`tree-${r.key}`}
                    onClick={() => onPick(r.key)}
                  >
                    <RepoMark repo={r.repo} known={known} />
                    <span className="name">
                      {r.role === "conductor"
                        ? r.repo
                        : r.name === "main terminal"
                          ? r.name
                          : paneLabel(r.pane)}
                    </span>
                    {fresh.has(r.key) ? <span className="new">new</span> : null}
                    <span className="end">
                      <Glyph kind="pane" state={r.state} />
                      {below > 0 ? <span className="faint"> {below}</span> : null}
                    </span>
                  </Button>
                  <Eye shut={eyeShut} what={whatOf(r)} testId={`eye-${r.key}`} onClick={() => onEye(r.key)} />
                </div>
              );
            })}
          </div>
        );
      })}
    </nav>
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
