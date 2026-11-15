import type { RunPlanView } from "../api.ts";
import { useDaemon } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import type { RepoSystemPlan } from "../model.ts";
import { lintSummary, routeHash } from "../model.ts";
import { Notice } from "./common.tsx";

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

/**
 * On a system run's approval card: the system plan in one line (its steps, status, lint), the way
 * to read or change it, and Approve for the plan itself while it waits for one, closed with the
 * reason while the lint has errors.
 */
export function SystemPlanLine({ plan, runId }: { readonly plan: RepoSystemPlan; readonly runId: string }) {
  const { client } = useDaemon();
  const action = useAction();
  const errors = plan.lint.problems.filter((p) => p.severity === "error");
  const waits = plan.status === "draft" || plan.approval?.stale === true;
  return (
    <section className="plan-line" data-testid="system-plan-line">
      <h3>The system plan</h3>
      <div>
        <span className="mono">{plan.plan.id}</span> · {plan.steps.length} steps · {plan.status}
        {plan.approval?.stale ? " · approval stale" : ""} ·{" "}
        <span className={errors.length > 0 ? "red" : plan.lint.problems.length > 0 ? "amber" : "green"}>
          lint: {lintSummary(plan.lint)}
        </span>{" "}
        <a href={routeHash({ screen: "run", runId, tab: "plan" })}>Review / edit the system plan</a>
        {waits ? (
          <button
            type="button"
            className="approve-plan"
            disabled={errors.length > 0 || action.busy}
            title={errors.length > 0 ? `fix the lint first: ${errors[0]?.message}` : undefined}
            onClick={() =>
              void action.run((by) => client.approveSystemPlan(plan.plan.id, by, plan.repo), {
                who: true,
                done: "the system plan is approved",
              })
            }
          >
            Approve the system plan
          </button>
        ) : null}
      </div>
      <Notice {...action.notice} />
    </section>
  );
}
