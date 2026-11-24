/**
 * The filter bar of Terminals (round 22): chips per repository, state and role, each with its
 * count; a click hides or shows a value, Alt+click shows only it (again: all). Words narrow it
 * further; "Showing N of M" says what is hidden, Reset shows all. On the All view it also chooses
 * how the tiles are grouped. The decisions are `toggleFilter` and `passes` (terminals.ts).
 */
import {
  type FilterDimension,
  filterValues,
  NO_FILTER,
  passes,
  repoMark,
  type TerminalFilter,
  type TerminalGrouping,
  type TerminalRow,
  toggleFilter,
} from "../terminals.ts";
import { Glyph } from "./glyph.tsx";

const DIMENSIONS: readonly { readonly d: FilterDimension; readonly label: string }[] = [
  { d: "repo", label: "Repo" },
  { d: "state", label: "State" },
  { d: "role", label: "Role" },
];
const GROUPINGS: readonly { readonly by: TerminalGrouping; readonly label: string }[] = [
  { by: "task", label: "by task" },
  { by: "repo", label: "by repo" },
  { by: "state", label: "by state" },
  { by: "flat", label: "flat" },
];
const CHIP_TITLE = "click: hide or show · alt+click: only this (again: all)";

export function TerminalFilters({
  rows,
  filter,
  onFilter,
  grouping,
  onGrouping,
  known,
}: {
  /** The folder's repositories: they take distinct hues (`repoMark`). */
  readonly known: readonly string[];
  /** Every terminal of the view, before the filter. */
  readonly rows: readonly TerminalRow[];
  readonly filter: TerminalFilter;
  onFilter(f: TerminalFilter): void;
  /** Set on the All view only: how its tiles are grouped. */
  readonly grouping?: TerminalGrouping | undefined;
  onGrouping?: ((by: TerminalGrouping) => void) | undefined;
}) {
  const shown = rows.filter((r) => passes(r, filter)).length;
  const hidden = rows.length - shown;
  const filtered =
    filter.text !== "" || filter.panes.length > 0 || Object.values(filter.hide).some((v) => v.length > 0);
  return (
    <div
      className="terminal-filters"
      role="toolbar"
      aria-label="filter terminals"
      data-testid="terminal-filters"
    >
      {DIMENSIONS.map(({ d, label }) => {
        const values = filterValues(rows, d);
        if (values.length === 0) return null;
        return (
          <div className="frow" key={d}>
            <span className="flabel">{label}</span>
            {values.map(({ value, count }) => {
              const on = !filter.hide[d].includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  className={`fchip${on ? " on" : ""}`}
                  aria-pressed={on}
                  title={CHIP_TITLE}
                  data-testid={`filter-${d}-${value}`}
                  style={
                    d === "repo"
                      ? ({ "--chip": repoMark(value, known).hue } as React.CSSProperties)
                      : undefined
                  }
                  onClick={(e) =>
                    onFilter(
                      toggleFilter(
                        filter,
                        d,
                        value,
                        e.altKey,
                        values.map((v) => v.value),
                      ),
                    )
                  }
                >
                  {d === "repo" ? <RepoMark repo={value} known={known} /> : null}
                  {d === "state" ? <Glyph kind="pane" state={value} /> : null}
                  {value}
                  <span className="n">{count}</span>
                </button>
              );
            })}
          </div>
        );
      })}
      <div className="frow">
        {grouping && onGrouping ? (
          <>
            <span className="flabel">Group</span>
            <fieldset className="seg" aria-label="group the tiles">
              {GROUPINGS.map(({ by, label }) => (
                <button
                  key={by}
                  type="button"
                  aria-pressed={grouping === by}
                  data-testid={`group-${by}`}
                  onClick={() => onGrouping(by)}
                >
                  {label}
                </button>
              ))}
            </fieldset>
          </>
        ) : null}
        <input
          type="search"
          className="ftext"
          aria-label="filter terminals by words"
          placeholder="filter: worker, repo, task…"
          value={filter.text}
          onChange={(e) => onFilter({ ...filter, text: e.target.value })}
        />
        <span className="shown" data-testid="filter-shown">
          Showing <b>{shown}</b> of {rows.length}
          {hidden > 0 ? <span className="amber"> · {hidden} hidden</span> : null}
        </span>
        {filtered ? (
          <button
            type="button"
            className="ghost"
            data-testid="filter-reset"
            onClick={() => onFilter(NO_FILTER)}
          >
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A repository's two letters on its hue (`repoMark`): the same on the chips, the tree and the tiles. */
export const RepoMark = ({ repo, known }: { readonly repo: string; readonly known: readonly string[] }) => {
  const m = repoMark(repo, known);
  return (
    <span className="repo-mark" style={{ background: m.hue }} aria-hidden="true">
      {m.letters}
    </span>
  );
};
