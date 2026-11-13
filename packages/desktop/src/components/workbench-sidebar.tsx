/** The workbench's sidebar (S6): the repositories with their tabs, and the panes of the shown repository. */
import type { PaneView } from "../api.ts";
import {
  lookOf,
  needsPerson,
  paneLabel,
  paneStateOf,
  plural,
  type WorkbenchRepo,
  type WorkbenchTab,
} from "../model.ts";
import { Glyph } from "./glyph.tsx";

export function WorkbenchSidebar({
  repos,
  repo,
  tab,
  panes,
  focused,
  symbols,
  onRepo,
  onNew,
  onPane,
}: {
  readonly repos: readonly WorkbenchRepo[];
  readonly repo: WorkbenchRepo | undefined;
  readonly tab: WorkbenchTab | undefined;
  readonly panes: readonly PaneView[];
  readonly focused: string | undefined;
  readonly symbols: boolean;
  onRepo(id: string): void;
  onNew(): void;
  onPane(tabKey: string, paneId: string): void;
}) {
  return (
    <aside className="sidebar" aria-label="repositories and agents">
      {repos.map((r, i) => {
        const waiting = r.tabs.filter(
          (t) => t.attention !== undefined && needsPerson({ attention: t.attention }),
        );
        return (
          <button
            type="button"
            key={r.id}
            className={`ws${r.id === repo?.id ? " sel" : ""}`}
            aria-current={r.id === repo?.id ? "true" : undefined}
            onClick={() => onRepo(r.id)}
          >
            <span className="l1">
              <span className="faint">{i + 1}</span>
              <b>{r.label}</b>
              <span className="spacer" />
              <Glyph kind="attention" state={r.attention} />
            </span>
            <span className="l2 faint">
              {plural(r.tabs.length, "tab")}
              {waiting.length > 0 ? ` · ${waiting.length} wait for you` : ""}
            </span>
          </button>
        );
      })}
      <button type="button" className="ws new faint" onClick={onNew}>
        <span className="l1">new</span>
      </button>
      <span className="spacer" />
      {(repo?.tabs ?? []).map((t) => {
        const own = t.panes.map((id) => panes.find((p) => p.id === id)).filter((p): p is PaneView => !!p);
        if (own.length === 0) return null;
        return (
          <div key={t.key} className="agents">
            <div className="sec">
              {t.label}
              {t.run ? <span className="faint"> · {t.run.stage}</span> : null}
              {t.run && t.run.questions.length > 0 ? (
                <span className="amber"> · ? {t.run.questions.length}</span>
              ) : null}
            </div>
            {own.map((p) => {
              const state = paneStateOf(p);
              return (
                <button
                  type="button"
                  key={p.id}
                  className={`ag${focused === p.id && t.key === tab?.key ? " sel" : ""}`}
                  aria-current={focused === p.id && t.key === tab?.key ? "true" : undefined}
                  onClick={() => onPane(t.key, p.id)}
                >
                  <Glyph kind="pane" state={state} dot={!symbols} />
                  <span className="n">{paneLabel(p)}</span>
                  <span className={lookOf("pane", state).tone}>{state}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </aside>
  );
}
