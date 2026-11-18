/**
 * A system plan as a flow: its task on the left, its steps by wave and repository, an arrow for
 * every `dependsOn`, each step in the colour of its child run (dashed while it has none), the
 * critical path drawn heavier. A click opens the step's child run, or its plan while it has none.
 */
import { lookOf, type Tone } from "../model.ts";
import { criticalPath, FLOW, type FlowNode, type PlanFlowLayout, planFlow, waitsText } from "../plan-flow.ts";

const TONE_VAR: Record<Tone, string> = {
  amber: "amber",
  violet: "violet",
  red: "red",
  green: "green",
  blue: "blue",
  teal: "teal",
  faint: "grey",
};

const toneOf = (n: Pick<FlowNode, "state">) =>
  n.state === "pending" ? "faint" : (lookOf("run", n.state).tone ?? "faint");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function PlanFlowGraph({
  view,
  runs,
  dim = false,
  onOpenRun,
  onOpenStep,
  testId,
}: {
  readonly view: Parameters<typeof planFlow>[0];
  readonly runs: Parameters<typeof planFlow>[1];
  /** A plan finished in the last day: shown, dimmed. */
  readonly dim?: boolean;
  onOpenRun(runId: string): void;
  /** A step that has not started: its plan. */
  onOpenStep(stepId: string): void;
  readonly testId?: string;
}) {
  const flow: PlanFlowLayout = planFlow(view, runs);
  const chain = criticalPath(view);
  const open = (n: FlowNode) => {
    if (n.kind === "task") return;
    if (n.runId) onOpenRun(n.runId);
    else onOpenStep(n.id);
  };
  return (
    <figure
      className={`plan-flow${dim ? " finished" : ""}`}
      data-testid={testId ?? `plan-flow-${view.plan.id}`}
    >
      <div className="canvas">
        <svg
          width={flow.width}
          height={flow.height}
          viewBox={`0 0 ${flow.width} ${flow.height}`}
          role="img"
          aria-label={`flow of ${view.plan.task}`}
        >
          <defs>
            {(["plain", "critical"] as const).map((kind) => (
              <marker
                key={kind}
                id={`flow-arrow-${kind}-${view.plan.id}`}
                viewBox="0 0 10 10"
                refX="10"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                markerUnits="strokeWidth"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className={`arrowhead ${kind}`} />
              </marker>
            ))}
          </defs>
          {flow.lanes.map((l) => (
            <g key={l.name}>
              <rect
                className="lane"
                x={FLOW.LEFT + FLOW.TASK_W + FLOW.COL_GAP / 2}
                y={l.y}
                width={flow.width - FLOW.TASK_W - FLOW.COL_GAP / 2 - FLOW.LEFT * 1.5}
                height={l.h}
                rx={8}
              />
              <text className="lanename" x={FLOW.LEFT + FLOW.TASK_W + FLOW.COL_GAP / 2 + 10} y={l.y + 15}>
                {l.name}
              </text>
            </g>
          ))}
          {flow.columns.map((c) => (
            <text key={c.label} className="colname" x={c.x} y={FLOW.TOP - 9}>
              {c.label}
            </text>
          ))}
          {flow.edges.map((e) => (
            <path
              key={`${e.from}>${e.to}`}
              className={`flow-edge${e.critical ? " critical" : ""}${e.met ? " met" : ""}`}
              d={e.d}
              markerEnd={`url(#flow-arrow-${e.critical ? "critical" : "plain"}-${view.plan.id})`}
              data-edge={`${e.from}>${e.to}`}
            />
          ))}
          {flow.nodes.map((n) => {
            const tone = toneOf(n);
            const waits = waitsText(n);
            const line =
              n.kind === "task"
                ? n.sub
                : [n.sub, n.state === "pending" ? waits : n.state, n.stage].filter(Boolean).join(" · ");
            const body = (
              <>
                <rect
                  className={`flow-node ${n.kind}${n.state === "pending" ? " pending" : ""}${n.critical ? " critical" : ""}`}
                  x={n.x}
                  y={n.y}
                  width={n.w}
                  height={n.h}
                  rx={8}
                  stroke={`var(--${TONE_VAR[tone]})`}
                />
                <text x={n.x + 10} y={n.y + 22} className="flow-title">
                  {n.kind === "step" ? `${n.state === "pending" ? "◌" : lookOf("run", n.state).glyph} ` : ""}
                  {cut(n.label, n.kind === "task" ? 22 : 26)}
                </text>
                <text x={n.x + 10} y={n.y + 42} className={`flow-sub ${tone}`}>
                  {cut(line, n.kind === "task" ? 26 : 36)}
                </text>
                <title>
                  {[n.label, line, waits && n.state === "pending" ? waits : undefined]
                    .filter(Boolean)
                    .join("\n")}
                </title>
              </>
            );
            return n.kind === "task" ? (
              <g key={n.id} data-node={n.id}>
                {body}
              </g>
            ) : (
              // biome-ignore lint/a11y/useValidAnchor: an SVG link opens the step's run or its plan in the app
              <a
                key={n.id}
                href="#"
                data-node={n.id}
                data-state={n.state}
                aria-label={`${n.label} · ${n.state === "pending" ? (waits ?? "pending") : n.state}`}
                onClick={(e) => {
                  e.preventDefault();
                  open(n);
                }}
              >
                {body}
              </a>
            );
          })}
        </svg>
      </div>
      <figcaption className="faint">
        {chain.length > 1 ? (
          <>
            critical path ({chain.length} steps):{" "}
            <span className="mono">{chain.levels.map((l) => l.join(" | ")).join(" → ")}</span>
          </>
        ) : (
          "every step waits only for the task"
        )}
        {" · "}an arrow leads from a step to the one that waits for it; a dashed step has not started
      </figcaption>
    </figure>
  );
}
