/** Under a system run's header: its plan's progress and what it waits for, with the child to act on. */

import { Glyph } from "../../shared/components/glyph.tsx";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { shortRunId } from "../../shared/model/format.ts";
import { lookOf } from "../../shared/model/look.ts";
import { routeHash } from "../../shared/model/route.ts";
import type { Run } from "../../shared/model/runs.ts";
import { runTabFor } from "../../shared/model/runs.ts";
import { systemPlanOf, systemRunSummary } from "../../shared/model/system-plans.ts";

export function SystemRunBar({ run }: { readonly run: Run }) {
  const { systemPlans, runs } = useDaemon("systemPlans", "runs");
  const plan = systemPlanOf(systemPlans, run, runs);
  if (!plan) return null;
  const s = systemRunSummary(plan, run, runs);
  const child = s.blocker ? runs.find((r) => r.runId === s.blocker?.runId) : undefined;
  return (
    <div className="system-run-bar" data-testid="system-run-bar">
      <span>
        System plan <span className="mono">{s.planId}</span>:{" "}
        <strong>
          {s.done}/{s.total}
        </strong>{" "}
        steps done
      </span>
      {s.blocker ? (
        <span className={lookOf("run", s.blocker.state).tone} data-testid="system-run-blocker">
          <Glyph kind="run" state={s.blocker.state} /> blocked by{" "}
          <a
            href={routeHash({
              screen: "run",
              runId: s.blocker.runId,
              tab: child ? runTabFor(child) : "overview",
            })}
            title={`${s.blocker.task}\n${s.blocker.runId}`}
          >
            {s.blocker.task.length > 60 ? `${s.blocker.task.slice(0, 59)}…` : s.blocker.task}
          </a>{" "}
          <span className="faint mono">({shortRunId(s.blocker.runId)})</span>: {s.blocker.state}
        </span>
      ) : s.waiting ? (
        <span className="muted">{s.waiting}</span>
      ) : null}
    </div>
  );
}
