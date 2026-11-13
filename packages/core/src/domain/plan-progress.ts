import { MetatorError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";
import type { RunStatus } from "./run-record.ts";

/**
 * A plan item's progress from the run that carries it out (refactor moves, system steps): done
 * when the run is, blocked when it escalated or was aborted, running while it is active.
 */
export function progressOf<S extends string>(run: RunStatus, current: S): S | "done" | "blocked" | "running" {
  if (run === "done") return "done";
  if (run === "aborted" || run === "escalated") return "blocked";
  return current === "pending" ? "running" : current;
}

/** Who approved a plan, when, and the digest of what they approved. */
export interface PlanApproval {
  readonly by: string;
  readonly at: string;
  readonly digest: string;
}

/** What refactor plans and system plans share: an id, a status and a person's approval. */
export interface ApprovablePlan {
  readonly id: string;
  readonly status: "draft" | "approved" | "running" | "done";
  readonly approval?: PlanApproval | undefined;
}

/**
 * The plan as a person approved it now: lint must be clean (a stale approval is exactly what
 * approving again fixes; every other error blocks), and a plan that runs or is done stays as it is.
 */
export function approvePlan<P extends ApprovablePlan>(
  plan: P,
  problems: readonly { readonly severity: string; readonly code?: string | undefined }[],
  approval: PlanApproval,
  lintHint: string,
): Result<P, MetatorError> {
  const blocking = problems.filter((p) => p.severity === "error" && p.code !== "stale-approval");
  if (blocking.length > 0)
    return err(
      new MetatorError(
        "CHECK_FAILED",
        `${plan.id}: ${blocking.length} lint error(s); fix them before approving`,
        { hint: lintHint, details: { problems: blocking } },
      ),
    );
  if (plan.status === "running" || plan.status === "done")
    return err(MetatorError.usage(`${plan.id} is ${plan.status}; it cannot be approved again`));
  return ok({ ...plan, status: "approved", approval });
}

/**
 * The plan when its approval still covers it: approved by a person, and its `items` ("moves",
 * "steps") unchanged since (`digest` is the digest of the plan as it is now).
 */
export function requireApproved<P extends ApprovablePlan>(
  plan: P,
  digest: string,
  items: string,
  approveHint: string,
): Result<P & { readonly approval: PlanApproval }, MetatorError> {
  if (plan.status === "draft" || !plan.approval)
    return err(MetatorError.usage(`${plan.id} is not approved`, approveHint));
  if (plan.approval.digest !== digest)
    return err(
      MetatorError.usage(
        `the ${items} of ${plan.id} changed after ${plan.approval.by} approved them`,
        "Approve the plan again.",
      ),
    );
  return ok(plan as P & { readonly approval: PlanApproval });
}

/** What an agent wrote is a draft: an approval it wrote itself is dropped. The same plan when it is one. */
export function asDraft<P extends ApprovablePlan>(plan: P): P {
  if (!plan.approval && plan.status === "draft") return plan;
  const { approval: _, ...draft } = plan;
  return { ...draft, status: "draft" } as P;
}

/** A plan is done when it has items and every one of them is. */
export const settled = (items: readonly { readonly status: string }[]): boolean =>
  items.length > 0 && items.every((i) => i.status === "done");
