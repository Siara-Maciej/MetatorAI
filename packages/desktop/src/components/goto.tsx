/** The go-to picker (S6, prefix+g): every pane and question, filtered by state or text. */
import { useMemo, useState } from "react";
import type { PaneView } from "../api.ts";
import { type GotoFilter, type GotoRow, gotoRows, type WorkbenchRepo } from "../model.ts";

const FILTERS: { id: GotoFilter; label: string; key: string }[] = [
  { id: "all", label: "all", key: "a" },
  { id: "blocked", label: "blocked", key: "b" },
  { id: "working", label: "working", key: "w" },
  { id: "idle", label: "idle", key: "i" },
  { id: "done", label: "done", key: "d" },
];

export function GotoPicker({
  repos,
  panes,
  onPick,
  onClose,
}: {
  readonly repos: readonly WorkbenchRepo[];
  readonly panes: readonly PaneView[];
  onPick(row: GotoRow): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<GotoFilter>("all");
  const [index, setIndex] = useState(0);
  const rows = useMemo(() => gotoRows(repos, panes, filter, query), [repos, panes, filter, query]);
  const choose = (f: GotoFilter) => {
    setFilter(f);
    setIndex(0);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const pick = rows[index];
    if (e.key === "ArrowDown") setIndex((i) => Math.min(rows.length - 1, i + 1));
    else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
    else if (e.key === "Enter" && pick) onPick(pick);
    else if (e.key === "Escape") onClose();
    // With an empty query the filter letters are keys.
    else if (query === "" && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const f = FILTERS.find((x) => x.key === e.key);
      if (f) {
        e.preventDefault();
        choose(f.id);
      } else if (e.key === "j") {
        e.preventDefault();
        setIndex((i) => Math.min(rows.length - 1, i + 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      }
    } else return;
    if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) e.preventDefault();
  };
  return (
    <div className="backdrop goto-backdrop">
      <button type="button" className="scrim" aria-label="close" onClick={onClose} />
      <div className="goto" role="dialog" aria-label="Go to">
        <div className="head">
          <span className="teal mono">›</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the picker is a keyboard tool; it opens with the key
            autoFocus
            aria-label="Go to"
            placeholder="agent, tab, question…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKey}
          />
          <span className="filters">
            {FILTERS.map((f) => (
              <button
                type="button"
                key={f.id}
                className={`chip${filter === f.id ? " on" : ""}`}
                onClick={() => choose(f.id)}
              >
                {f.label} · {f.key}
              </button>
            ))}
          </span>
        </div>
        <div className="rows">
          {rows.map((r, i) => (
            <button
              type="button"
              key={r.id}
              className={`row${i === index ? " sel" : ""}`}
              aria-current={i === index ? "true" : undefined}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onPick(r)}
            >
              <span className={`glyph ${r.state ?? ""}`}>{glyph(r.state)}</span>
              <span className="n">
                {r.tab.label} <span className="dim">·</span> {r.label}
              </span>
              <span className="dim">{r.detail}</span>
            </button>
          ))}
          {rows.length === 0 ? <div className="empty">Nothing matches.</div> : null}
        </div>
        <div className="hint dim">
          <kbd>↑↓</kbd> <kbd>j k</kbd> choose · <kbd>↵</kbd> go · <kbd>a b w i d</kbd> filter · <kbd>esc</kbd>
        </div>
      </div>
    </div>
  );
}

const glyph = (state: GotoRow["state"]): string =>
  state === "blocked"
    ? "!"
    : state === "waiting" || state === "question"
      ? "?"
      : state === "working"
        ? "⋮"
        : state === "exited"
          ? "✓"
          : "$";
