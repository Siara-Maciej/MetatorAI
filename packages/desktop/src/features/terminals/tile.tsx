/**
 * A terminal's tile on a task's, a session's or the All view (round 22): its repository band, what
 * it is in its task, the links to the terminal that started it and to the ones below that ask, and
 * its pane. It reads its own facts from the screen's store (ADR-0113): a focus, a zoom or a flash
 * elsewhere does not draw it again.
 */
import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Glyph } from "../../shared/components/glyph.tsx";
import { lookOf } from "../../shared/model/look.ts";
import { paneLabel } from "../../shared/model/panes.ts";
import { routeHash } from "../../shared/model/route.ts";
import { Button } from "../../ui/button.tsx";
import { ContinueTask } from "./continue.tsx";
import { PaneSlot } from "./pane-slot.tsx";
import { focusKeyOf, type TerminalsState, useTerminals, useTerminalsApi } from "./state.ts";
import { RepoMark } from "./terminal-filters.tsx";
import { repoMark, rowsBelow, subBadge } from "./terminals.ts";
import { paneAt, rowAt } from "./view.ts";

/** What a tile draws, as values: the tile draws again only when one of them changed. */
function tileFacts(s: TerminalsState, key: string) {
  const { view, chosen, session, rows, now } = s.model;
  const row = rowAt(s.model, key);
  const p = paneAt(s.model, key) ?? row?.pane;
  const main = view === "task" && p !== undefined && chosen?.main === p;
  // On the task's view a tile is a repository session: its badge opens its own view. The main
  // terminal, when it is the task run's own conductor, opens the task run's session.
  const own =
    (chosen && p ? [chosen.own, ...chosen.sessions].find((x) => x.pane === p) : undefined) ??
    (main && chosen?.main === chosen?.own.pane ? chosen?.own : undefined);
  const parent = rowAt(s.model, row?.parent);
  const below = row ? rowsBelow(rows, row.key) : [];
  return {
    id: p?.id,
    role: p?.role,
    paneRepo: p?.repo,
    label: !p
      ? ""
      : view === "all"
        ? (row?.name ?? paneLabel(p))
        : view === "session"
          ? p === session?.pane
            ? `${session?.label}: its main terminal`
            : "sub-terminal"
          : main
            ? chosen?.main?.startedRun
              ? "main terminal: where the task was given"
              : "main terminal: the task's conductor"
            : (own?.label ?? paneLabel(p)),
    main,
    view,
    taskRun: chosen?.runId,
    ownRun: own?.runId,
    badge: view === "task" && own ? subBadge(own, now) : undefined,
    parentKey: parent?.key,
    parentName: parent?.name,
    asking: below.filter((r) => r.state === "asks").length,
    below: below.length,
    state: row?.state,
    lineage: view === "all" && row && s.grouping !== "task" ? row.task.title : undefined,
    repoName: row?.repo ?? "this repository",
  };
}

export const Tile = memo(function Tile({ paneKey: key }: { readonly paneKey: string }) {
  const api = useTerminalsApi();
  const t = useTerminals(useShallow((s: TerminalsState) => tileFacts(s, key)));
  const flash = useTerminals((s) => s.flash === key);
  const fresh = useTerminals((s) => s.fresh.includes(key));
  const known = useTerminals((s) => s.model.folderRepos);
  if (t.id === undefined) return null;
  const id = t.id;
  /** The next terminal below that asks, after the focused one. */
  const nextAsking = () => {
    const s = api.getState();
    const row = rowAt(s.model, key);
    const asking = row ? rowsBelow(s.model.rows, row.key).filter((r) => r.state === "asks") : [];
    const at = asking.findIndex((r) => r.key === focusKeyOf(s));
    const next = asking[(at + 1) % asking.length];
    if (next) s.goTo(next.key, true);
  };
  return (
    <div
      className={`tile${t.main ? " main" : ""}${flash ? " flash" : ""}${fresh ? " fresh" : ""}`}
      data-testid={`tile-${id}`}
      data-tile={key}
      data-repo={t.paneRepo}
      style={{ "--repo": repoMark(t.repoName, known).hue } as React.CSSProperties}
    >
      <div className="tile-band">
        <RepoMark repo={t.repoName} known={known} />
        <span className="repo-name">{t.repoName}</span>
        <span className="role">{t.role}</span>
        <span className="spacer" />
        {t.main ? <ContinueTaskButton where="tile" /> : null}
        {t.state ? (
          <span className={`tstate ${lookOf("pane", t.state).tone}`} data-testid={`state-${id}`}>
            <Glyph kind="pane" state={t.state} /> {t.state}
          </span>
        ) : null}
      </div>
      <div className="tile-head">
        {/* Where the terminal is, when its group does not say it already (grouped by task it does). */}
        {t.lineage !== undefined ? (
          <>
            <span className="lineage" title={t.lineage}>
              {t.lineage}
            </span>
            <span className="faint">›</span>
          </>
        ) : null}
        <span className="tile-label">{t.label}</span>
        {t.parentKey !== undefined ? (
          <Button
            className="parent-link"
            data-testid={`parent-${id}`}
            title="show the terminal that started this one"
            onClick={() => api.getState().goTo(t.parentKey as string, true)}
          >
            ↑ parent: {t.parentName}
          </Button>
        ) : null}
        {t.asking > 0 ? (
          <Button
            className="asks-link"
            data-testid={`asks-${id}`}
            title={`show the terminal that asks${t.asking > 1 ? " (again: the next one)" : ""}`}
            onClick={nextAsking}
          >
            ? {t.asking} asks ›
          </Button>
        ) : null}
        {t.view === "task" && t.ownRun !== undefined && (!t.main || t.badge) ? (
          <a
            className="ghost open-session"
            href={routeHash({ screen: "grid", task: t.taskRun, session: t.ownRun })}
            data-testid={`open-session-${t.ownRun}`}
          >
            {t.main ? t.badge : (t.badge ?? "its terminals")} ›
          </a>
        ) : t.view === "all" && t.below > 0 ? (
          <span className="faint below">{t.below} below</span>
        ) : null}
      </div>
      <PaneSlot paneKey={key} />
    </div>
  );
});

/** "Continue task", on the bar or the main tile, while something of the chosen task is paused or undriven. */
export function ContinueTaskButton({ where }: { readonly where: "bar" | "tile" }) {
  const show = useTerminals((s) => s.model.chosen !== undefined && s.model.view !== "tabs");
  const pending = useTerminals((s) => s.model.pending);
  const api = useTerminalsApi();
  return show ? (
    <ContinueTask where={where} pending={pending} onContinue={() => void api.getState().continueTask()} />
  ) : null;
}
