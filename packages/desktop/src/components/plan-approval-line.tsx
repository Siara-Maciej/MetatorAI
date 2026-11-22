/**
 * A plan at its approval, in full: the run's plan (steps with files, tests first and what each
 * waits for) or the system plan (its flow and its steps per repository), its lint, what the
 * planner changed since its previous version, and "Ask for changes": the person says in words
 * what should be different, the gate is rejected with those words, and the planner writes a new
 * plan. Nobody edits a plan by hand.
 */
import { useState } from "react";
import type { RunPlanView } from "../api.ts";
import type { RepoSystemPlan } from "../model.ts";
import { lintSummary } from "../model.ts";
import { ProblemList } from "./doc-editor.tsx";
import { FromPlanButton } from "./from-plan-button.tsx";
import { PlanChanges } from "./plan-changes.tsx";
import { SystemPlanContent } from "./system-plan.tsx";

const or = (items: readonly string[] | undefined) => (items && items.length > 0 ? items.join(", ") : "—");

/** The run's plan in full, read-only. */
export function RunPlanFull({
  view,
  runId,
  repo,
}: {
  readonly view: RunPlanView;
  /** The plan's run, a top one: "Create Backlog item" keeps the plan in the Backlog (round 17). */
  readonly runId?: string | undefined;
  readonly repo?: string | undefined;
}) {
  const errors = view.lint.problems.filter((p) => p.severity === "error");
  const plan = view.plan;
  return (
    <section className="plan-full" data-testid="plan-approval-line" aria-label="the plan">
      <h3>
        The plan{plan ? ` · ${plan.steps.length} steps` : ""} ·{" "}
        <span className={errors.length > 0 ? "red" : view.lint.problems.length > 0 ? "amber" : "green"}>
          lint: {lintSummary(view.lint)}
        </span>
        {plan && runId ? (
          <>
            <span className="spacer" />
            <FromPlanButton runId={runId} repo={repo} />
          </>
        ) : null}
      </h3>
      <PlanChanges changes={view.changes} previousAt={view.previous?.at} />
      {plan ? (
        <>
          <div className="muted">
            {plan.task}
            {plan.scope.length > 0 ? (
              <span className="faint mono"> · scope {plan.scope.join(", ")}</span>
            ) : null}
          </div>
          <table className="sp-steps plan-steps" data-testid="plan-steps">
            <thead>
              <tr>
                {["step", "file", "what", "tests first", "after"].map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plan.steps.map((s) => (
                <tr key={s.id} data-testid={`plan-step-${s.id}`}>
                  <td className="mono">{s.id}</td>
                  <td className="mono">
                    {s.action} {s.path}
                  </td>
                  <td>{s.intent}</td>
                  <td className="mono">{or(s.testsFirst)}</td>
                  <td className="mono">{or(s.dependsOn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <div className="faint">No plan written yet.</div>
      )}
      <ProblemList problems={view.lint.problems} testId="plan-card-problems" />
    </section>
  );
}

/** A system plan in full on its approval card: its flow and its steps per repository. */
export function SystemPlanFull({
  plan,
  runId,
}: {
  readonly plan: RepoSystemPlan;
  /** The system run: "Create Backlog item" keeps the plan in the Backlog (round 17). */
  readonly runId?: string | undefined;
}) {
  const errors = plan.lint.problems.filter((p) => p.severity === "error");
  return (
    <section className="plan-full" data-testid="system-plan-line" aria-label="the system plan">
      <h3>
        The system plan <span className="mono">{plan.plan.id}</span> · {plan.steps.length} steps ·{" "}
        {plan.status} ·{" "}
        <span className={errors.length > 0 ? "red" : plan.lint.problems.length > 0 ? "amber" : "green"}>
          lint: {lintSummary(plan.lint)}
        </span>
        {runId ? (
          <>
            <span className="spacer" />
            <FromPlanButton runId={runId} repo={plan.repo} />
          </>
        ) : null}
      </h3>
      <SystemPlanContent view={plan} repo={plan.repo} foldSteps />
    </section>
  );
}

/** The lint's errors as words for the planner: what "Ask the planner to fix it" starts with. */
export const lintRequest = (
  problems: readonly {
    readonly severity: string;
    readonly message: string;
    readonly step?: string | undefined;
  }[],
): string => {
  const errors = problems.filter((p) => p.severity === "error");
  return errors.length === 0
    ? ""
    : `Fix the plan's lint errors: ${errors.map((p) => (p.step ? `${p.step}: ${p.message}` : p.message)).join("; ")}.`;
};

/**
 * "Ask for changes": the words go to the gate as its Reject with them as the reason, which sends
 * the run back to its planner. With lint errors the request can start from them.
 */
export function AskForChanges({
  blocked,
  lintText,
  busy,
  onSend,
}: {
  /** Why Approve is closed (the lint has errors), when it is. */
  readonly blocked?: string | undefined;
  readonly lintText: string;
  readonly busy: boolean;
  onSend(text: string): void;
}) {
  const [text, setText] = useState("");
  return (
    <section className="ask-changes" data-testid="ask-for-changes" aria-label="ask for changes">
      {blocked ? (
        <div className="red" data-testid="closed-option">
          Approve is closed: {blocked}.{" "}
          {lintText ? (
            <button type="button" onClick={() => setText(lintText)}>
              Ask the planner to fix it
            </button>
          ) : null}
        </div>
      ) : null}
      <label>
        <span className="dim">What should be different? The planner writes a new plan.</span>
        <textarea
          aria-label="what should change in the plan"
          placeholder="for example: S2 also needs a test for a product without a currency"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button type="button" disabled={busy || text.trim() === ""} onClick={() => onSend(text.trim())}>
        Ask for changes
      </button>
    </section>
  );
}
