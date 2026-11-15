import type { RunPlanView } from "../api.ts";
import { lintSummary, routeHash } from "../model.ts";

/** On a plan's approval card: the plan in one line, its lint now, and the way to read or change it. */
export function PlanApprovalLine({ view, runId }: { readonly view: RunPlanView; readonly runId: string }) {
  const errors = view.lint.problems.filter((p) => p.severity === "error");
  return (
    <section className="plan-line" data-testid="plan-approval-line">
      <h3>The plan</h3>
      <div>
        {view.plan ? `${view.plan.steps.length} steps` : "no plan written"} ·{" "}
        <span className={errors.length > 0 ? "red" : view.lint.problems.length > 0 ? "amber" : "green"}>
          lint: {lintSummary(view.lint)}
        </span>
        {errors[0] ? <span className="muted"> · {errors[0].message}</span> : null}{" "}
        <a href={routeHash({ screen: "run", runId, tab: "plan" })}>Review / edit the plan</a>
      </div>
    </section>
  );
}
