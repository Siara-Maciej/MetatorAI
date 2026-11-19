/**
 * A system plan: one change across repositories, read-only. The planner writes it; a person reads
 * it here (its flow on the task's own page), approves it, and asks for changes on its approval card.
 * Its steps are grouped by repository with the run each started and that run's state.
 */
import type { SystemPlanView } from "../api.ts";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { clock, lintSummary, lookOf, plural, type Run, routeHash, sameRepo } from "../model.ts";
import { Notice } from "./common.tsx";
import { ProblemList } from "./doc-editor.tsx";
import { PlanChanges } from "./plan-changes.tsx";
import { PlanFlowGraph } from "./plan-flow-graph.tsx";
import { RetryStepButton } from "./retry-step.tsx";

/** A repository as a person names it: the last part of its path. */
const repoName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

export function SystemPlanPanel({
  planId,
  planOfRun,
  repo,
  onOpenRun,
  flow = true,
}: {
  /** The plan, by its id; or the system run whose plan it is (found by its task). */
  readonly planId?: string | undefined;
  readonly planOfRun?: Run | undefined;
  readonly repo: string | undefined;
  onOpenRun?: ((runId: string) => void) | undefined;
  /** Its flow: shown on the task's own page only. */
  readonly flow?: boolean | undefined;
}) {
  const { client } = useDaemon();
  // A finished system run's plan is not among the open ones: it is found in the repository's list.
  const list = usePolled(
    `system-plans-of:${repo ?? ""}:${planOfRun?.runId ?? ""}`,
    () => (planId ? Promise.resolve({ ok: true, data: [] }) : client.systemPlans(repo)),
    planId ? 0 : 10_000,
  );
  const id = planId ?? list.data?.find((p) => p.task === planOfRun?.task)?.id;
  if (!id)
    return (
      <div className="empty" data-testid="system-plan">
        <h2>No system plan yet</h2>
        <p>
          {list.error
            ? `The system plans could not be read: ${list.error}`
            : "The run's plan stage writes the system plan: the steps of the change in each repository. It appears here as it does."}
        </p>
      </div>
    );
  return <SystemPlanBody id={id} repo={repo} onOpenRun={onOpenRun} flow={flow} />;
}

function SystemPlanBody({
  id,
  repo,
  onOpenRun,
  flow = true,
}: {
  readonly id: string;
  readonly repo: string | undefined;
  onOpenRun?: ((runId: string) => void) | undefined;
  readonly flow?: boolean | undefined;
}) {
  const { client } = useDaemon();
  const plan = usePolled(`system-plan:${repo ?? ""}:${id}`, () => client.systemPlan(id, repo), 3000);
  const action = useAction(plan.reload);
  const view = plan.data;
  if (!view) return <div className="empty">{plan.error ?? `reading the system plan ${id}…`}</div>;
  const errors = view.lint.problems.filter((p) => p.severity === "error");
  const approve = () =>
    action.run((by) => client.approveSystemPlan(id, by, repo), {
      who: true,
      refused: "the plan was not approved",
      done: "approved: its steps start in the deploy order",
    });
  return (
    <div className="system-plan" data-testid="system-plan">
      <header className="sp-head">
        <h2>
          System plan <span className="mono">{view.plan.id}</span>
        </h2>
        <span className="chip">{view.status}</span>
        {view.approval ? (
          <span className={view.approval.stale ? "chip amber" : "chip green"} data-testid="approval">
            {view.approval.stale
              ? `approved by ${view.approval.by} before it changed: approve again`
              : `approved by ${view.approval.by} · ${clock(view.approval.at)}`}
          </span>
        ) : (
          <span className="chip">not approved</span>
        )}
        <span className="faint mono">{view.file}</span>
      </header>
      <div className="sp-task">{view.plan.task}</div>
      <div className="lint-bar" data-testid="system-plan-lint">
        <span className={errors.length > 0 ? "red" : view.lint.problems.length > 0 ? "amber" : "green"}>
          lint: {lintSummary(view.lint)}
        </span>
        <span className="faint">
          {" "}
          · the planner writes this plan; ask it for changes on the plan's approval card
        </span>
        <span className="spacer" />
        {view.status === "draft" || view.approval?.stale ? (
          <button
            type="button"
            className="primary"
            disabled={errors.length > 0 || action.busy}
            title={errors.length > 0 ? `the lint has an error: ${errors[0]?.message}` : "approve the plan"}
            onClick={() => void approve()}
          >
            Approve
          </button>
        ) : null}
      </div>
      <Notice {...action.notice} />
      <SystemPlanContent view={view} repo={repo} onOpenRun={onOpenRun} flow={flow} />
    </div>
  );
}

/**
 * What a system plan says, read-only: its lint, what changed since the planner's previous version,
 * its flow (on the task's own page), and its steps per repository with the run each started.
 */
export function SystemPlanContent({
  view,
  repo,
  onOpenRun,
  flow = true,
  foldSteps = false,
}: {
  readonly view: SystemPlanView;
  readonly repo: string | undefined;
  onOpenRun?: ((runId: string) => void) | undefined;
  readonly flow?: boolean | undefined;
  /** The step tables folded under the flow (a decision card: the flow and its actions first). */
  readonly foldSteps?: boolean | undefined;
}) {
  const { runs } = useDaemon();
  const repos = [...new Set(view.steps.map((s) => s.repo))];
  return (
    <>
      <ProblemList problems={view.lint.problems} testId="system-plan-problems" />
      <PlanChanges changes={view.changes} previousAt={view.previous?.at} />
      {flow ? (
        <section className="sp-waves" aria-label="deploy order">
          <h3>Deploy order</h3>
          {view.waves.length === 0 ? (
            <div className="faint">
              No order: the steps wait on each other in a circle (the lint says where).
            </div>
          ) : (
            <PlanFlowGraph
              view={view}
              runs={runs}
              onOpenRun={(runId) => {
                if (onOpenRun) onOpenRun(runId);
                else window.location.hash = routeHash({ screen: "run", runId, tab: "overview" });
              }}
              onOpenStep={(stepId) =>
                document
                  .querySelector(`[data-testid="system-step-${stepId}"]`)
                  ?.scrollIntoView({ block: "center" })
              }
            />
          )}
        </section>
      ) : (
        <div className="faint" data-testid="deploy-order">
          deploy order: {view.waves.map((w) => `wave ${w.wave}: ${w.steps.join(", ")}`).join(" → ") || "none"}
        </div>
      )}
      {foldSteps ? (
        <details className="sp-steps-fold" data-testid="system-plan-steps">
          <summary>
            {plural(view.steps.length, "step")} in {plural(repos.length, "repository", "repositories")}
          </summary>
          {repos.map((r) => (
            <section key={r} className="sp-repo" aria-label={`steps in ${r}`}>
              <h3 title={r}>{repoName(r)}</h3>
              <table className="sp-steps">
                <thead>
                  <tr>
                    {["step", "what", "after", "status", "run"].map((h) => (
                      <th key={h} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.steps
                    .filter((s) => s.repo === r)
                    .map((s) => {
                      const child = s.run ? runs.find((x) => x.runId === s.run) : undefined;
                      return (
                        <tr key={s.id} data-testid={`system-step-${s.id}`}>
                          <td className="mono">{s.id}</td>
                          <td>
                            {s.task}
                            <div className="faint">{s.app}</div>
                          </td>
                          <td className="mono">{s.dependsOn.join(", ") || "—"}</td>
                          <td>
                            <span
                              className={
                                lookOf(
                                  "step",
                                  s.status === "running"
                                    ? "in-progress"
                                    : s.status === "pending"
                                      ? "todo"
                                      : s.status,
                                ).tone
                              }
                            >
                              {s.status}
                            </span>
                          </td>
                          <td>
                            {s.run ? (
                              <a
                                title={child?.task ?? s.run}
                                href={routeHash({ screen: "run", runId: s.run, tab: "overview" })}
                                onClick={(e) => {
                                  if (!onOpenRun) return;
                                  e.preventDefault();
                                  onOpenRun(s.run as string);
                                }}
                              >
                                open run
                              </a>
                            ) : (
                              <span className="faint">not started</span>
                            )}
                            {s.runState ? (
                              <span className="faint">
                                {" "}
                                · {s.runState}
                                {s.runStage ? ` at ${s.runStage}` : ""}
                                {child && !sameRepo(child.repo, repo) && child.repo
                                  ? ` · ${repoName(child.repo)}`
                                  : ""}
                              </span>
                            ) : null}
                            {s.runState === "aborted" ? (
                              <RetryStepButton planId={view.plan.id} step={s.id} repo={repo} />
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </section>
          ))}
        </details>
      ) : (
        <>
          {repos.map((r) => (
            <section key={r} className="sp-repo" aria-label={`steps in ${r}`}>
              <h3 title={r}>{repoName(r)}</h3>
              <table className="sp-steps">
                <thead>
                  <tr>
                    {["step", "what", "after", "status", "run"].map((h) => (
                      <th key={h} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.steps
                    .filter((s) => s.repo === r)
                    .map((s) => {
                      const child = s.run ? runs.find((x) => x.runId === s.run) : undefined;
                      return (
                        <tr key={s.id} data-testid={`system-step-${s.id}`}>
                          <td className="mono">{s.id}</td>
                          <td>
                            {s.task}
                            <div className="faint">{s.app}</div>
                          </td>
                          <td className="mono">{s.dependsOn.join(", ") || "—"}</td>
                          <td>
                            <span
                              className={
                                lookOf(
                                  "step",
                                  s.status === "running"
                                    ? "in-progress"
                                    : s.status === "pending"
                                      ? "todo"
                                      : s.status,
                                ).tone
                              }
                            >
                              {s.status}
                            </span>
                          </td>
                          <td>
                            {s.run ? (
                              <a
                                title={child?.task ?? s.run}
                                href={routeHash({ screen: "run", runId: s.run, tab: "overview" })}
                                onClick={(e) => {
                                  if (!onOpenRun) return;
                                  e.preventDefault();
                                  onOpenRun(s.run as string);
                                }}
                              >
                                open run
                              </a>
                            ) : (
                              <span className="faint">not started</span>
                            )}
                            {s.runState ? (
                              <span className="faint">
                                {" "}
                                · {s.runState}
                                {s.runStage ? ` at ${s.runStage}` : ""}
                                {child && !sameRepo(child.repo, repo) && child.repo
                                  ? ` · ${repoName(child.repo)}`
                                  : ""}
                              </span>
                            ) : null}
                            {s.runState === "aborted" ? (
                              <RetryStepButton planId={view.plan.id} step={s.id} repo={repo} />
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </section>
          ))}
          {view.steps.length === 0 ? <div className="faint">The plan has no step yet.</div> : null}
          <div className="faint">
            {plural(view.steps.length, "step")} in {plural(repos.length, "repository", "repositories")}
          </div>
        </>
      )}
    </>
  );
}
