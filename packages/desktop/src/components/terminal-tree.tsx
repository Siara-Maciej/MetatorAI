/**
 * Every terminal as a tree (round 22), beside the tiles: task → main terminal → sessions →
 * sub-terminals, each with its repository's mark and its state. A terminal the filter hides stays
 * in the tree, dimmed, so nothing goes missing; a click shows it (the filter opens just enough).
 */
import { paneLabel } from "../model.ts";
import { passes, type TerminalFilter, type TerminalRow } from "../terminals.ts";
import { Glyph } from "./glyph.tsx";
import { RepoMark } from "./terminal-filters.tsx";

export function TerminalTree({
  rows,
  filter,
  focused,
  fresh,
  onPick,
  known,
}: {
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
  return (
    <nav className="terminal-tree" aria-label="every terminal" data-testid="terminal-tree">
      {tasks.map((t) => {
        const own = rows.filter((r) => r.task === t);
        return (
          <div key={t.runId} className="ttask">
            <div className="ttitle" title={t.title}>
              <span className="name">{t.title}</span>
              <span className="faint">{own.length}</span>
            </div>
            {own.map((r) => {
              const below = rows.filter((x) => x.parent === r.key).length;
              return (
                <button
                  key={r.key}
                  type="button"
                  className={`tnode${passes(r, filter) ? "" : " hidden"}${focused === r.key ? " focus" : ""}${
                    fresh.has(r.key) ? " fresh" : ""
                  }`}
                  style={{ paddingLeft: `${6 + depthOf(r) * 12}px` }}
                  title={`${r.repo} · ${r.role} · ${r.state}${passes(r, filter) ? "" : " (hidden by the filter)"}`}
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
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
