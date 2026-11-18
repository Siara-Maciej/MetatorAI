/** Screen 3: lanes per repository, sessions as cards, parent → child arrows, dashed links for messages and shared files. */
import type { Conflict, RunMessage } from "../api.ts";
import { systemRunOf } from "../board.ts";
import { Notice } from "../components/common.tsx";
import { PlanFlowGraph } from "../components/plan-flow-graph.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import {
  drawnLanes,
  finishedText,
  GRAPH,
  graphLayout,
  isFinished,
  linkPath,
  lookOf,
  openRuns,
  type Run,
  routeHash,
  runStateOf,
  runTabFor,
  sameRepo,
  type Tone,
} from "../model.ts";

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

export function DependenciesPanel({ onOpenRun }: { onOpenRun?: ((runId: string) => void) | undefined } = {}) {
  const { runs, repos, client, systemPlans } = useDaemon();
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
  // A decomposed task is drawn as its plan's flow; the runs graph keeps the runs of no plan.
  const inPlans = new Set(
    systemPlans.flatMap((p) => [
      ...p.steps.flatMap((s) => (s.run ? [s.run] : [])),
      ...(systemRunOf(p, runs) ? [(systemRunOf(p, runs) as Run).runId] : []),
    ]),
  );
  const loose = runs.filter((r) => !inPlans.has(r.runId));
  const go = (runId: string) => {
    if (onOpenRun) onOpenRun(runId);
    else window.location.hash = routeHash({ screen: "run", runId, tab: "overview" });
  };
  // Every open run, and the finished ones of the last day (dimmed) or linked to one shown.
  // Only the repositories that have a run to draw get a lane: never an empty box.
  const drawn = drawnLanes(lanes, graphLayout(loose, lanes).nodes);
  const graph = graphLayout(loose, drawn);
  const at = new Map(graph.nodes.map((n) => [n.run.runId, n]));
  const links = [
    ...conflicts.map((c) => ({
      from: c.runs[0],
      to: c.runs[1],
      label: `shares ${c.files[0]}`,
      kind: "conflict" as const,
      data: c,
    })),
    ...messages
      .filter((m) => m.fromRun !== m.toRun && at.has(m.fromRun) && at.has(m.toRun))
      .map((m) => ({ from: m.fromRun, to: m.toRun, label: m.topic, kind: "message" as const, data: m })),
  ];
  const { W, H } = GRAPH;
  const width = graph.width;
  const height = graph.height;
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
        {systemPlans.length > 0 ? (
          <section className="plan-flows" aria-label="tasks as flows">
            {systemPlans.map((p) => {
              const head = systemRunOf(p, runs);
              return (
                <div key={`${p.repo ?? ""}/${p.plan.id}`} className="plan-flow-box">
                  <h3>
                    {p.plan.task} <span className="faint mono">{p.plan.id}</span>
                    <span className="faint"> · {p.status}</span>
                  </h3>
                  <PlanFlowGraph
                    view={p}
                    runs={runs}
                    dim={p.status === "done" || (head !== undefined && isFinished(head))}
                    onOpenRun={go}
                    onOpenStep={() => {
                      window.location.hash = head
                        ? routeHash({ screen: "run", runId: head.runId, tab: "plan" })
                        : routeHash({ screen: "overview", tab: "system" });
                    }}
                  />
                </div>
              );
            })}
            <h3 className="runs-title">
              Other runs
              {graph.nodes.length === 0 ? (
                <span className="faint"> · none: every run is a step of a task above</span>
              ) : null}
            </h3>
          </section>
        ) : null}
        {graph.nodes.length === 0 ? (
          systemPlans.length > 0 ? null : (
            <div className="empty-line faint" data-testid="runs-graph-empty">
              No run to draw: open runs and the ones finished in the last day appear here.
            </div>
          )
        ) : (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="runs graph"
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
            {drawn.map((lane, li) => (
              <g key={lane || "."}>
                <rect
                  className="lane"
                  x={8}
                  y={GRAPH.TOP - 20 + li * GRAPH.LANE}
                  width={width - 16}
                  height={GRAPH.LANE - 12}
                  rx={8}
                />
                <text className="lanename" x={16} y={GRAPH.TOP - 4 + li * GRAPH.LANE}>
                  {lane || "this repository"} · {graph.nodes.filter((n) => sameRepo(n.run.repo, lane)).length}
                </text>
              </g>
            ))}
            {graph.edges.map((e) => (
              <path key={`${e.from}>${e.to}`} className="edge" d={e.d} markerEnd="url(#arrow)" />
            ))}
            {links.map((l, i) => {
              const d = linkPath(at.get(l.from), at.get(l.to));
              return d ? <path key={`${l.from}~${l.to}-${String(i)}`} className="edge msg" d={d} /> : null;
            })}
            {graph.nodes.map(({ run: r, x, y, finished }) => {
              const state = runStateOf(r);
              return (
                <a
                  key={`${r.repo ?? ""}/${r.runId}`}
                  href={routeHash({ screen: "run", runId: r.runId, tab: runTabFor(r) })}
                  aria-label={`${r.task} · ${state}`}
                  className={finished ? "finished" : undefined}
                >
                  <rect
                    className="node"
                    x={x}
                    y={y}
                    width={W}
                    height={H}
                    rx={8}
                    stroke={`var(--${TONE_VAR[lookOf("run", state).tone ?? "faint"]})`}
                  />
                  <text x={x + 10} y={y + 20} fontWeight={600}>
                    {r.task.length > 28 ? `${r.task.slice(0, 27)}…` : r.task}
                  </text>
                  <text x={x + 10} y={y + 38} className="sub">
                    {finished ? state : `${state} · ${r.stage}`} · {r.host ?? "no host"}
                  </text>
                  {finished ? <title>{finishedText(r)}</title> : null}
                </a>
              );
            })}
          </svg>
        )}
      </div>
      <aside className="side">
        <div className="box">
          <h3>Links</h3>
          {links.length === 0 ? (
            <div className="muted">No messages or shared files between the runs shown.</div>
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
            A task split by a system plan is drawn as its flow: a column per wave, a lane per repository, an
            arrow from each step to the steps that wait for it, a dashed step not started yet. Below, an arrow
            runs from a run to the runs it started; a dashed amber line is data between two runs, never an
            instruction. Finished work of the last day stays, dimmed.
          </div>
        </div>
        <Notice {...action.notice} />
      </aside>
    </div>
  );
}
