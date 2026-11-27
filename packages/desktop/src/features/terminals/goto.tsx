/**
 * The go-to picker (S6, prefix+g): every pane and question, filtered by state or text. What it
 * keeps is its own store (`goto-state.ts`, ADR-0113): typing draws the field and the rows again, a
 * state chip draws the chips that changed, moving the pointer draws two rows.
 */

import { useMemo } from "react";
import type { PaneView } from "../../shared/api/api.ts";
import { Glyph } from "../../shared/components/glyph.tsx";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { Goto, type GotoState, useGoto, useGotoApi } from "./goto-state.ts";
import { type GotoFilter, type GotoRow, gotoRows, type WorkbenchRepo } from "./model.ts";

const FILTERS: { id: GotoFilter; label: string; key: string }[] = [
  { id: "all", label: "all", key: "a" },
  { id: "asks", label: "asks", key: "b" },
  { id: "working", label: "working", key: "w" },
  { id: "idle", label: "idle", key: "i" },
  { id: "done", label: "done", key: "d" },
];

/** What the rows are made of. */
interface GotoData {
  readonly repos: readonly WorkbenchRepo[];
  readonly panes: readonly PaneView[];
  /** The tasks' panes, by their place in the task. */
  readonly taskRows: readonly GotoRow[];
}

const rowsOf = (data: GotoData, s: Pick<GotoState, "filter" | "query">) =>
  gotoRows(data.repos, data.panes, s.filter, s.query, data.taskRows);

export function GotoPicker({
  repos,
  panes,
  taskRows = [],
  onPick,
  onClose,
}: {
  readonly repos: readonly WorkbenchRepo[];
  readonly panes: readonly PaneView[];
  /** The tasks' panes, by their place in the task. */
  readonly taskRows?: readonly GotoRow[];
  onPick(row: GotoRow): void;
  onClose(): void;
}) {
  const data: GotoData = { repos, panes, taskRows };
  return (
    <ScopeProvider store={Goto} init={undefined}>
      <Modal label="Go to" className="goto" closeOnBackdrop onClose={onClose}>
        <div className="head">
          <span className="teal mono">›</span>
          <GotoInput data={data} onPick={onPick} onClose={onClose} />
          <span className="filters">
            {FILTERS.map((f) => (
              <FilterChip key={f.id} id={f.id} label={f.label} hotkey={f.key} />
            ))}
          </span>
        </div>
        <GotoRows data={data} onPick={onPick} />
        <GotoHint />
      </Modal>
    </ScopeProvider>
  );
}

/** The words field: the keys of the picker are its keys. */
export function GotoInput({
  data,
  onPick,
  onClose,
}: {
  readonly data: GotoData;
  onPick(row: GotoRow): void;
  onClose(): void;
}) {
  const query = useGoto((s) => s.query);
  const api = useGotoApi();
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const s = api.getState();
    const rows = rowsOf(data, s);
    const pick = rows[s.index];
    if (e.key === "ArrowDown") s.move(1, rows.length);
    else if (e.key === "ArrowUp") s.move(-1, rows.length);
    else if (e.key === "Enter" && pick) onPick(pick);
    else if (e.key === "Escape") onClose();
    // With an empty query the filter letters are keys.
    else if (s.query === "" && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const f = FILTERS.find((x) => x.key === e.key);
      if (f) {
        e.preventDefault();
        s.choose(f.id);
      } else if (e.key === "j") {
        e.preventDefault();
        s.move(1, rows.length);
      } else if (e.key === "k") {
        e.preventDefault();
        s.move(-1, rows.length);
      }
    } else return;
    if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) e.preventDefault();
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the picker is a keyboard tool; it opens with the key
      autoFocus
      aria-label="Go to"
      placeholder="agent, tab, question…"
      value={query}
      onChange={(e) => api.getState().type(e.target.value)}
      onKeyDown={onKey}
    />
  );
}

/** A state chip: it draws again only when it is chosen or left. */
export function FilterChip({
  id,
  label,
  hotkey,
}: {
  readonly id: GotoFilter;
  readonly label: string;
  readonly hotkey: string;
}) {
  const on = useGoto((s) => s.filter === id);
  const choose = useGoto((s) => s.choose);
  return (
    <Button className={`chip${on ? " on" : ""}`} onClick={() => choose(id)}>
      {label} · {hotkey}
    </Button>
  );
}

/** The rows the words and the state let through. */
export function GotoRows({ data, onPick }: { readonly data: GotoData; onPick(row: GotoRow): void }) {
  const query = useGoto((s) => s.query);
  const filter = useGoto((s) => s.filter);
  const { repos, panes, taskRows } = data;
  const rows = useMemo(
    () => gotoRows(repos, panes, filter, query, taskRows),
    [repos, panes, filter, query, taskRows],
  );
  return (
    <div className="rows">
      {rows.map((r, i) => (
        <GotoRowButton key={r.id} row={r} at={i} onPick={onPick} />
      ))}
      {rows.length === 0 ? <div className="empty">Nothing matches.</div> : null}
    </div>
  );
}

function GotoRowButton({
  row: r,
  at,
  onPick,
}: {
  readonly row: GotoRow;
  readonly at: number;
  onPick(row: GotoRow): void;
}) {
  const sel = useGoto((s) => s.index === at);
  const point = useGoto((s) => s.point);
  return (
    <Button
      className={`row${sel ? " sel" : ""}`}
      aria-current={sel ? "true" : undefined}
      onMouseEnter={() => point(at)}
      onClick={() => onPick(r)}
    >
      <Glyph kind="pane" state={r.state} />
      <span className="n">
        {r.path ?? (
          <>
            {r.tab?.label} <span className="dim">·</span> {r.label}
          </>
        )}
      </span>
      <span className="dim">{r.detail}</span>
    </Button>
  );
}

export function GotoHint() {
  return (
    <div className="hint dim">
      <kbd>↑↓</kbd> <kbd>j k</kbd> choose · <kbd>↵</kbd> go · <kbd>a b w i d</kbd> filter · <kbd>esc</kbd>
    </div>
  );
}
