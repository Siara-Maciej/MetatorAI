/** Screen 7: a feature group as a grid of terminals; at most one tile is yours to type in. */
import { useEffect, useState } from "react";
import { attentionLabel, Chip, Dot } from "../components/chips.tsx";
import { PaneTerminal, RunTerminal, sendLine } from "../components/terminal.tsx";
import { useDaemon } from "../daemon.tsx";
import { groupByFeature, paneLabel, panesOfRun, type Run, stateTone } from "../model.ts";

type Layout = 1 | 2 | 3;

const remembered = (group: string): { layout: Layout; pinned: string[] } => {
  try {
    const raw = localStorage.getItem(`metator.grid.${group}`);
    return raw ? (JSON.parse(raw) as { layout: Layout; pinned: string[] }) : { layout: 2, pinned: [] };
  } catch {
    return { layout: 2, pinned: [] };
  }
};

export function TerminalsScreen({
  group,
  onOpenSession,
  onNew,
}: {
  readonly group?: string;
  onOpenSession(runId: string): void;
  onNew(): void;
}) {
  const { runs, panes, client, url, me, setMe } = useDaemon();
  const groups = groupByFeature<Run>(runs);
  const g = group ? groups.groups.find((x) => x.parent === group) : groups.groups[0];
  const key = g?.parent ?? "all";
  const [{ layout, pinned }, setPrefs] = useState(() => remembered(key));
  useEffect(() => setPrefs(remembered(key)), [key]);
  useEffect(() => {
    try {
      localStorage.setItem(`metator.grid.${key}`, JSON.stringify({ layout, pinned }));
    } catch {
      /* nothing kept */
    }
  }, [key, layout, pinned]);
  const steps = g ? g.steps : runs.filter((r) => r.status === "active").slice(0, 9);
  const extra = pinned.map((id) => runs.find((r) => r.runId === id)).filter((r): r is Run => r !== undefined);
  const tiles: Run[] = [...steps, ...extra.filter((e) => !steps.some((s) => s.runId === e.runId))];
  const [focus, setFocus] = useState<string | undefined>(tiles[0]?.runId);
  // The focused run's own panes as the tiles (R5): its conductor, workers and shells side by side.
  const [showPanes, setShowPanes] = useState(false);
  const focused = runs.find((r) => r.runId === focus);
  const runPanes = focused ? panesOfRun(panes, focused.runId) : [];
  const [lines, setLines] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string>();
  const parent = g ? runs.find((r) => r.runId === g.parent) : undefined;
  const follow = () => setFocus(tiles.find((t) => t.attention === "you")?.runId ?? focus);
  const attach = async (runId: string, repo?: string) => {
    const who = me || window.prompt("your name") || "";
    if (!who) return;
    setMe(who);
    // One keyboard, one PTY: release whatever else is yours first.
    for (const t of tiles)
      if (t.driver === "human" && t.attachedBy === who && t.runId !== runId)
        await client.release(t.runId, t.repo);
    const r = await client.attach(runId, who, repo);
    setNote(r.ok ? undefined : r.error?.message);
    setFocus(runId);
  };
  const candidates = runs.filter((r) => r.status === "active" && !tiles.some((t) => t.runId === r.runId));
  return (
    <div className="grid">
      <div className="head">
        <span className="chip blue">FEATURE</span>
        <strong>{parent?.task ?? (g ? g.parent : "every active session")}</strong>
        <span className="dim">
          {steps.length} sessions in order{extra.length > 0 ? ` · + ${extra.length} pinned` : ""}
        </span>
        <span className="spacer" />
        {([1, 2, 3] as Layout[]).map((l) => (
          <button
            type="button"
            key={l}
            aria-pressed={layout === l}
            onClick={() => setPrefs({ layout: l, pinned })}
          >
            {l === 1 ? "1" : `${l}×${l}`}
          </button>
        ))}
        <button type="button" onClick={follow}>
          Follow: next that needs you
        </button>
        <button
          type="button"
          aria-pressed={showPanes}
          disabled={runPanes.length === 0}
          title="The focused session's panes (conductor, workers, shells) as the tiles"
          onClick={() => setShowPanes(!showPanes)}
        >
          Panes · {runPanes.length}
        </button>
        <select
          aria-label="pin a session"
          value=""
          onChange={(e) => e.target.value && setPrefs({ layout, pinned: [...pinned, e.target.value] })}
        >
          <option value="">+ Add session…</option>
          {candidates.map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.task}
            </option>
          ))}
          <option value="">— or start one —</option>
        </select>
        <button type="button" onClick={onNew}>
          + New
        </button>
      </div>
      {note ? <div className="banner">{note}</div> : null}
      <div className={`tiles l${layout}`} data-testid="tiles">
        {showPanes && focused
          ? runPanes.map((p) => {
              const mine = focused.driver === "human" && focused.attachedBy === me && me !== "";
              return (
                <section key={p.id} className="tile" aria-label={paneLabel(p)}>
                  <div className="bar">
                    <span className="n">{p.id}</span>
                    <span className="title">{paneLabel(p)}</span>
                    <span className="dim">{p.state?.reason ?? ""}</span>
                    <Chip tone={stateTone(p.state?.state)}>
                      {p.state?.state ?? (p.live?.alive ? "live" : "off")}
                    </Chip>
                    {p.role !== "conductor" ? (
                      <button
                        type="button"
                        className="ghost"
                        title={`close ${p.id}`}
                        onClick={() => void client.closePane(p.id, focused.repo)}
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                  {p.live?.alive ? (
                    <PaneTerminal paneId={p.id} repo={focused.repo} canType={mine} />
                  ) : (
                    <div className="empty">pane {p.id} has no live terminal</div>
                  )}
                </section>
              );
            })
          : null}
        {showPanes && focused
          ? null
          : tiles.map((t, i) => {
              const mine = t.driver === "human" && t.attachedBy === me && me !== "";
              const isPinned = !steps.some((s) => s.runId === t.runId);
              return (
                <section
                  key={t.runId}
                  className={`tile${focus === t.runId ? " focused" : ""}${isPinned ? " pinned" : ""}`}
                  aria-label={t.task}
                >
                  <div className="bar">
                    <span
                      className={`n`}
                      style={{
                        color: `var(--${t.attention === "you" ? "amber" : t.attention === "driving" ? "violet" : "grey"})`,
                      }}
                    >
                      {isPinned ? "📌" : i + 1}
                    </span>
                    <span className="title">{t.task}</span>
                    <span className="dim">
                      {t.repo ? `${t.repo} · ` : ""}
                      {t.host ?? "no host"}
                      {t.parent && i > 0 ? ` · after ${i}` : ""}
                    </span>
                    <Dot attention={t.attention} human={t.driver === "human"} />
                    <span className="dim">{attentionLabel(t.attention)}</span>
                    {mine ? (
                      <button type="button" onClick={() => void client.release(t.runId, t.repo)}>
                        Release
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void attach(t.runId, t.repo)}
                        disabled={t.driver === "human"}
                      >
                        Attach
                      </button>
                    )}
                    {isPinned ? (
                      <button
                        type="button"
                        className="ghost"
                        title="unpin"
                        onClick={() => setPrefs({ layout, pinned: pinned.filter((p) => p !== t.runId) })}
                      >
                        ✕
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost"
                      title="expand"
                      onClick={() => onOpenSession(t.runId)}
                    >
                      ⤢
                    </button>
                  </div>
                  <RunTerminal runId={t.runId} repo={t.repo} canType={mine} />
                  {mine ? (
                    <form
                      className="composer"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void sendLine(t.runId, url, me, t.repo, lines[t.runId] ?? "").then((refused) => {
                          setNote(refused);
                          if (!refused) setLines({ ...lines, [t.runId]: "" });
                        });
                      }}
                    >
                      <input
                        aria-label={`message to ${t.task}`}
                        value={lines[t.runId] ?? ""}
                        onChange={(e) => setLines({ ...lines, [t.runId]: e.target.value })}
                      />
                      <button type="submit">Send</button>
                    </form>
                  ) : null}
                </section>
              );
            })}
        {tiles.length === 0 && !showPanes ? (
          <div className="empty">No active session. Start one with + New.</div>
        ) : null}
      </div>
    </div>
  );
}
