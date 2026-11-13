/** Screen 3: lanes per repository, sessions as cards, parent → child arrows, dashed links for messages and shared files. */
import type { Conflict, RunMessage } from "../api.ts";
import { Notice } from "../components/common.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { lookOf, openRuns, routeHash, runTabFor, sameRepo, type Tone } from "../model.ts";

/** The custom property of a tone, for an SVG stroke. */
const TONE_VAR: Record<Tone, string> = {
  amber: "amber",
  violet: "violet",
  red: "red",
  green: "green",
  blue: "blue",
  teal: "teal",
  faint: "grey",
};

const W = 220;
const H = 54;

export function DependenciesPanel() {
  const { runs, repos, client } = useDaemon();
  // Every run that is not finished, escalated ones included: what the panel and the top bar count.
  const active = openRuns(runs);
  // Asked again when the set of runs changes, not on every refresh of the state.
  const key = `graph:${repos.map((r) => r.name).join(",")}:${active.map((r) => `${r.repo ?? ""}/${r.runId}`).join(",")}`;
  const links0 = usePolled(
    key,
    async () => {
      const names = repos.length > 0 ? repos.map((r) => r.name) : [undefined];
      const [conflicts, messages] = await Promise.all([
        Promise.all(
          names.map(async (repo) => {
            const c = await client.conflicts(repo);
            return (c.data?.conflicts ?? []).map((x) => ({ ...x, ...(repo ? { repo } : {}) }));
          }),
        ),
        Promise.all(active.map(async (r) => (await client.messages(r.runId, r.repo)).data?.messages ?? [])),
      ]);
      return { ok: true, data: { conflicts: conflicts.flat(), messages: messages.flat() } };
    },
    5000,
  );
  const conflicts: readonly (Conflict & { repo?: string })[] = links0.data?.conflicts ?? [];
  const messages: readonly RunMessage[] = links0.data?.messages ?? [];
  const action = useAction(links0.reload);
  const lanes = repos.length > 0 ? repos.map((r) => r.name) : [""];
  const pos = new Map<string, { x: number; y: number }>();
  lanes.forEach((lane, li) => {
    active
      .filter((r) => sameRepo(r.repo, lane))
      .forEach((r, i) => {
        pos.set(r.runId, { x: 120 + i * (W + 30), y: 40 + li * (H + 60) });
      });
  });
  const edges = active.flatMap((r) =>
    (r.children ?? [])
      .filter((c) => pos.has(c))
      .map((c) => ({ from: r.runId, to: c, kind: "child" as const })),
  );
  const links = [
    ...conflicts.map((c) => ({
      from: c.runs[0],
      to: c.runs[1],
      label: `shares ${c.files[0]}`,
      kind: "conflict" as const,
      data: c,
    })),
    ...messages
      .filter((m) => pos.has(m.fromRun) && pos.has(m.toRun))
      .map((m) => ({ from: m.fromRun, to: m.toRun, label: m.topic, kind: "message" as const, data: m })),
  ];
  const line = (a: string, b: string) => {
    const p = pos.get(a);
    const q = pos.get(b);
    if (!p || !q) return undefined;
    return `M ${p.x + W} ${p.y + H / 2} C ${p.x + W + 40} ${p.y + H / 2}, ${q.x - 40} ${q.y + H / 2}, ${q.x} ${q.y + H / 2}`;
  };
  const width =
    160 + Math.max(1, ...lanes.map((l) => active.filter((r) => sameRepo(r.repo, l)).length)) * (W + 30);
  const height = 40 + lanes.length * (H + 60);
  const notify = (c: Conflict & { repo?: string }) =>
    action.run(
      async (by) => {
        const text = `both runs changed ${c.files.join(", ")}; merge ${c.mergeFirst} first, the other rebases on it`;
        const sent = await Promise.all(
          ([c.runs, [c.runs[1], c.runs[0]]] as const).map(([to, from]) =>
            client.message(to, from, "shared-file", text, [...c.files], by, c.repo),
          ),
        );
        return sent.find((r) => !r.ok) ?? { ok: true };
      },
      { who: true, done: "both runs were told" },
    );
  return (
    <div className="graph">
      <div className="canvas">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="runs graph"
          style={{ minWidth: width, minHeight: height }}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--teal)" />
            </marker>
          </defs>
          {lanes.map((lane, li) => (
            <g key={lane || "."}>
              <rect className="lane" x={8} y={20 + li * (H + 60)} width={width - 16} height={H + 40} rx={8} />
              <text className="lanename" x={16} y={36 + li * (H + 60)}>
                {(lane || "this repository").toUpperCase()} ·{" "}
                {active.filter((r) => sameRepo(r.repo, lane)).length}
              </text>
            </g>
          ))}
          {edges.map((e) => (
            <path key={`${e.from}>${e.to}`} className="edge" d={line(e.from, e.to)} />
          ))}
          {links.map((l, i) => (
            <g key={`${l.from}~${l.to}-${String(i)}`}>
              <path className="edge msg" d={line(l.from, l.to)} />
            </g>
          ))}
          {active.map((r) => {
            const p = pos.get(r.runId);
            if (!p) return null;
            return (
              <a
                key={r.runId}
                href={routeHash({ screen: "run", runId: r.runId, tab: runTabFor(r) })}
                aria-label={r.task}
              >
                <rect
                  className="node"
                  x={p.x}
                  y={p.y}
                  width={W}
                  height={H}
                  rx={8}
                  stroke={`var(--${TONE_VAR[lookOf("attention", r.attention).tone ?? "faint"]})`}
                />
                <text x={p.x + 10} y={p.y + 20} fontWeight={600}>
                  {r.task.length > 28 ? `${r.task.slice(0, 27)}…` : r.task}
                </text>
                <text x={p.x + 10} y={p.y + 38} fill="var(--muted)">
                  {r.stage} · {r.host ?? "no host"} · {r.driver === "human" ? "you" : "agent"}
                </text>
              </a>
            );
          })}
        </svg>
      </div>
      <aside className="side">
        <div className="box">
          <h3>Links</h3>
          {links.length === 0 ? (
            <div className="muted">no messages or shared files between active runs</div>
          ) : null}
          <ul>
            {links.map((l, i) => (
              <li key={`${l.from}-${l.to}-${String(i)}`}>
                <span className="dim">
                  {l.kind === "conflict" ? "shared file" : `message · ${l.label}`}:{" "}
                </span>
                <code>{l.from}</code> ↔ <code>{l.to}</code>
                {l.kind === "conflict" ? (
                  <div className="chips gap-top">
                    <span className="chip amber">merge {l.data.mergeFirst} first</span>
                    <button type="button" onClick={() => void notify(l.data)}>
                      Notify both
                    </button>
                  </div>
                ) : (
                  <div className="dim">{l.data.text}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="box">
          <h3>Waves</h3>
          <div className="muted">
            parent → child arrows follow the system plan; a dashed amber link is data between runs, never an
            instruction
          </div>
        </div>
        <Notice {...action.notice} />
      </aside>
    </div>
  );
}
