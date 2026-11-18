/** What the planner changed since its previous version of a plan: shown when the daemon says. */
import { clock } from "../model.ts";

export function PlanChanges({
  changes,
  previousAt,
}: {
  readonly changes?: readonly string[] | undefined;
  readonly previousAt?: string | undefined;
}) {
  if (!changes || changes.length === 0) return null;
  return (
    <section className="plan-changes" aria-label="what changed in the plan" data-testid="plan-changes">
      <h3>
        Changed since the previous plan{previousAt ? <span className="faint"> of {clock(previousAt)}</span> : null}
      </h3>
      <ul>
        {changes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </section>
  );
}
