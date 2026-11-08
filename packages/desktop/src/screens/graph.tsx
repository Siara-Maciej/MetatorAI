/** Screen 3: lanes per repository, sessions as cards, parent → child arrows, dashed links for messages and shared files. */
import { useCallback, useEffect, useState } from "react";
import type { Conflict, RunMessage } from "../api.ts";
import { useDaemon } from "../daemon.tsx";

const W = 220;
const H = 54;

export function GraphScreen() {
  const { runs, repos, client, me } = useDaemon();
  const [conflicts, setConflicts] = useState<(Conflict & { repo?: string })[]>([]);
  const [messages, setMessages] = useState<RunMessage[]>([]);
  const [note, setNote] = useState<string>();
  const load = useCallback(async () => {
    const names = repos.length > 0 ? repos.map((r) => r.name) : [undefined];
    const all: (Conflict & { repo?: string })[] = [];
    for (const repo of names) {
      const c = await client.conflicts(repo);
      if (c.ok && c.data) all.push(...c.data.conflicts.map((x) => ({ ...x, ...(repo ? { repo } : {}) })));
    }
    setConflicts(all);
    const msgs: RunMessage[] = [];
    for (const r of runs.filter((x) => x.status === "active")) {
      const m = await client.messages(r.runId, r.repo);
      if (m.ok && m.data) msgs.push(...m.data.messages);
    }
    setMessages(msgs);
  }, [client, repos, runs]);
  useEffect(() => {
    void load();
  }, [load]);
  const lanes = repos.length > 0 ? repos.map((r) => r.name) : [""];
  const active = runs.filter((r) => r.status === "active");
  const pos = new Map<string, { x: number; y: number }>();
  lanes.forEach((lane, li) => {
    active
      .filter((r) => (r.repo ?? "") === lane)
      .forEach((r, i) => {
        pos.set(r.runId, { x: 120 + i * (W + 30), y: 40 + li * (H + 60) });
      });
  });
  const color = (a: string) =>
    a === "you"
      ? "var(--amber)"
      : a === "driving"
        ? "var(--violet)"
        : a === "escalated"
          ? "var(--red)"
          : "var(--grey)";
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
    160 + Math.max(1, ...lanes.map((l) => active.filter((r) => (r.repo ?? "") === l).length)) * (W + 30);
  const height = 40 + lanes.length * (H + 60);
  const notify = async (c: Conflict & { repo?: string }) => {
    const who = me || "me";
    const text = `both runs changed ${c.files.join(", ")}; merge ${c.mergeFirst} first, the other rebases on it`;
    for (const [to, from] of [
      [c.runs[0], c.runs[1]],
      [c.runs[1], c.runs[0]],
    ] as const) {
      const r = await client.message(to, from, "shared-file", text, [...c.files], who, c.repo);
      if (!r.ok) setNote(r.error?.message);
    }
    await load();
  };
  return (
    <div className="graph">
      <div style={{ overflow: "auto" }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="sessions graph"
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
                {active.filter((r) => (r.repo ?? "") === lane).length}
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
              <a key={r.runId} href={`#/session/${encodeURIComponent(r.runId)}`} aria-label={r.task}>
                <rect
                  className="node"
                  x={p.x}
                  y={p.y}
                  width={W}
                  height={H}
                  rx={8}
                  stroke={color(r.attention)}
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
                  <div className="chips" style={{ marginTop: 4 }}>
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
        {note ? <div className="banner">{note}</div> : null}
      </aside>
    </div>
  );
}
