/**
 * A system plan: one change across repositories, read-only. The planner writes it; a person reads
 * it here (its flow on the task's own page), approves it, and asks for changes on its approval card.
 * Its steps are grouped by repository with the run each started and that run's state.
 */

import type { Envelope, PlanLintProblem, SystemPlanView } from "../../shared/api/api.ts";
import {
  readAgainNow,
  useDaemon,
  useDaemonStore,
  usePolled,
  usePolledSelect,
} from "../../shared/daemon/daemon.tsx";
import { systemRunOf } from "../../shared/model/board.ts";
import { clock, lintSummary, plural } from "../../shared/model/format.ts";
import { lookOf } from "../../shared/model/look.ts";
import { sameRepo } from "../../shared/model/places.ts";
import { routeHash } from "../../shared/model/route.ts";
import type { Run } from "../../shared/model/runs.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { ProblemList } from "./doc-editor.tsx";
import { FromPlanButton } from "./from-plan-button.tsx";
import { PlanActionNotice, PlanActionScope, usePlanStoreAction } from "./plan-action.tsx";
import { PlanChanges } from "./plan-changes.tsx";
import { PlanFlowGraph } from "./plan-flow-graph.tsx";
import { ChosenStep, useChosenStep } from "./plans-state.ts";
import { RetryStepButton } from "./retry-step.tsx";
import { StepDetailDialog } from "./step-detail.tsx";

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
  const { client } = useDaemon("client");
  // A finished system run's plan is not among the open ones: it is found in the repository's list.
  const key = `system-plans-of:${repo ?? ""}:${planOfRun?.runId ?? ""}`;
  const ask = () => (planId ? Promise.resolve({ ok: true, data: [] }) : client.systemPlans(repo));
  const ms = planId ? 0 : 10_000;
  const found = usePolledSelect(key, ask, ms, (list) => list?.find((p) => p.task === planOfRun?.task)?.id);
  const id = planId ?? found;
  if (!id)
    return (
      <div className="empty" data-testid="system-plan">
        <h2>No system plan yet</h2>
        <NoPlanYet listKey={key} ask={ask} ms={ms} />
      </div>
    );
  return (
    <PlanActionScope>
      <SystemPlanBody id={id} repo={repo} onOpenRun={onOpenRun} flow={flow} runId={planOfRun?.runId} />
    </PlanActionScope>
  );
}

function NoPlanYet({
  listKey,
  ask,
  ms,
}: {
  readonly listKey: string;
  readonly ask: () => Promise<Envelope<readonly { readonly id: string; readonly task: string }[]>>;
  readonly ms: number;
}) {
  const list = usePolled(listKey, ask, ms);
  return (
    <p>
      {list.error
        ? `The system plans could not be read: ${list.error}`
        : "The run's plan stage writes the system plan: the steps of the change in each repository. It appears here as it does."}
    </p>
  );
}

interface BodyOf {
  readonly id: string;
  readonly repo: string | undefined;
}

const planKey = ({ id, repo }: BodyOf) => `system-plan:${repo ?? ""}:${id}`;

/** The system plan, or `select`'s part of it (undefined before the first answer). */
function usePlan<R>(of: BodyOf, select: (view: SystemPlanView | undefined) => R): R {
  const { client } = useDaemon("client");
  return usePolledSelect(planKey(of), () => client.systemPlan(of.id, of.repo), 3000, select);
}
const whole = (v: SystemPlanView | undefined) => v;

function SystemPlanBody({
  id,
  repo,
  onOpenRun,
  flow = true,
  runId,
}: {
  readonly id: string;
  /** The system run whose plan it is, when the page knows it. */
  readonly runId?: string | undefined;
  readonly repo: string | undefined;
  onOpenRun?: ((runId: string) => void) | undefined;
  readonly flow?: boolean | undefined;
}) {
  const read = usePlan({ id, repo }, (v) => v !== undefined);
  if (!read) return <PlanReading id={id} repo={repo} />;
  return (
    <div className="system-plan" data-testid="system-plan">
      <PlanHead id={id} repo={repo} />
      <PlanTask id={id} repo={repo} />
      <PlanLintBar id={id} repo={repo} runId={runId} />
      <PlanActionNotice />
      <PlanContentOf id={id} repo={repo} onOpenRun={onOpenRun} flow={flow} />
    </div>
  );
}

function PlanReading(of: BodyOf) {
  const { client } = useDaemon("client");
  const plan = usePolled(planKey(of), () => client.systemPlan(of.id, of.repo), 3000);
  return <div className="empty">{plan.error ?? `reading the system plan ${of.id}…`}</div>;
}

function PlanHead(of: BodyOf) {
  const planId = usePlan(of, (v) => v?.plan.id);
  const status = usePlan(of, (v) => v?.status);
  const approval = usePlan(of, (v) => v?.approval);
  const file = usePlan(of, (v) => v?.file);
  return (
    <header className="sp-head">
      <h2>
        System plan <span className="mono">{planId}</span>
      </h2>
      <span className="chip">{status}</span>
      {approval ? (
        <span className={approval.stale ? "chip amber" : "chip green"} data-testid="approval">
          {approval.stale
            ? `approved by ${approval.by} before it changed: approve again`
            : `approved by ${approval.by} · ${clock(approval.at)}`}
        </span>
      ) : (
        <span className="chip">not approved</span>
      )}
      <span className="faint mono">{file}</span>
    </header>
  );
}

function PlanTask(of: BodyOf) {
  const task = usePlan(of, (v) => v?.plan.task);
  return <div className="sp-task">{task}</div>;
}

const NO_PROBLEMS: readonly PlanLintProblem[] = [];

/** Its lint, "Create Backlog item" from the system run, and Approve while it is a draft or stale. */
function PlanLintBar({ id, repo, runId }: BodyOf & { readonly runId: string | undefined }) {
  const { client, runs } = useDaemon("client", "runs");
  const daemon = useDaemonStore();
  const problems = usePlan({ id, repo }, (v) => v?.lint.problems ?? NO_PROBLEMS);
  const approvable = usePlan({ id, repo }, (v) => v?.status === "draft" || v?.approval?.stale === true);
  const ownRun = usePlan({ id, repo }, (v) => (v ? systemRunOf(v, runs)?.runId : undefined));
  const action = usePlanStoreAction(() => readAgainNow(daemon.getState().url, planKey({ id, repo })));
  const errors = problems.filter((p) => p.severity === "error");
  // "Create Backlog item" works from the system run: the plan, not run yet, lives in the Backlog.
  const systemRun = runId ?? ownRun;
  const approve = () =>
    action.run((by) => client.approveSystemPlan(id, by, repo), {
      who: true,
      refused: "the plan was not approved",
      done: "approved: its steps start in the deploy order",
    });
  return (
    <div className="lint-bar" data-testid="system-plan-lint">
      <span className={errors.length > 0 ? "red" : problems.length > 0 ? "amber" : "green"}>
        lint: {lintSummary({ problems })}
      </span>
      <span className="faint">
        {" "}
        · the planner writes this plan; ask it for changes on the plan's approval card
      </span>
      <span className="spacer" />
      {systemRun ? <FromPlanButton runId={systemRun} repo={repo} action={action} /> : null}
      {approvable ? (
        <Button
          variant="primary"
          disabled={errors.length > 0 || action.busy}
          title={errors.length > 0 ? `the lint has an error: ${errors[0]?.message}` : "approve the plan"}
          onClick={() => void approve()}
        >
          Approve
        </Button>
      ) : null}
    </div>
  );
}

function PlanContentOf({
  id,
  repo,
  onOpenRun,
  flow,
}: BodyOf & { onOpenRun?: ((runId: string) => void) | undefined; readonly flow: boolean }) {
  const view = usePlan({ id, repo }, whole);
  return view ? <SystemPlanContent view={view} repo={repo} onOpenRun={onOpenRun} flow={flow} /> : null;
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
  stepsOpen = false,
}: {
  readonly view: SystemPlanView;
  readonly repo: string | undefined;
  onOpenRun?: ((runId: string) => void) | undefined;
  readonly flow?: boolean | undefined;
  /** The step tables folded under the flow (a decision card: the flow and its actions first). */
  readonly foldSteps?: boolean | undefined;
  /** Folded tables open at first (a plan's approval card: the plan in full, foldable). */
  readonly stepsOpen?: boolean | undefined;
}) {
  return (
    <ScopeProvider store={ChosenStep} init={undefined}>
      <PlanContent
        view={view}
        repo={repo}
        onOpenRun={onOpenRun}
        flow={flow}
        foldSteps={foldSteps}
        stepsOpen={stepsOpen}
      />
    </ScopeProvider>
  );
}

/** The step whose tile was clicked: its detail. */
function ClickedStep({ view, repo }: { readonly view: SystemPlanView; readonly repo: string | undefined }) {
  const step = useChosenStep((s) => s.chosen);
  const choose = useChosenStep((s) => s.choose);
  return step ? (
    <StepDetailDialog view={view} stepId={step} repo={repo} onClose={() => choose(undefined)} />
  ) : null;
}

function PlanContent({
  view,
  repo,
  onOpenRun,
  flow,
  foldSteps,
  stepsOpen,
}: {
  readonly view: SystemPlanView;
  readonly repo: string | undefined;
  onOpenRun?: ((runId: string) => void) | undefined;
  readonly flow: boolean;
  readonly foldSteps: boolean;
  readonly stepsOpen: boolean;
}) {
  const { runs } = useDaemon("runs");
  const choose = useChosenStep((s) => s.choose);
  const repos = [...new Set(view.steps.map((s) => s.repo))];
  // The steps per repository: what each does, its contracts, what it waits for, how it stands.
  const tables = repos.map((r) => (
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
                    <div className="faint">
                      {s.app}
                      {s.contracts.length > 0
                        ? ` · contracts: ${s.contracts.map((c) => `${c.id} (${c.role})`).join(", ")}`
                        : ""}
                    </div>
                  </td>
                  <td className="mono">{s.dependsOn.join(", ") || "—"}</td>
                  <td>
                    <span
                      className={
                        lookOf(
                          "step",
                          s.status === "running" ? "in-progress" : s.status === "pending" ? "todo" : s.status,
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
  ));
  return (
    <>
      <ClickedStep view={view} repo={repo} />
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
            <PlanFlowGraph view={view} runs={runs} onOpenStep={choose} />
          )}
        </section>
      ) : (
        <div className="faint" data-testid="deploy-order">
          deploy order: {view.waves.map((w) => `wave ${w.wave}: ${w.steps.join(", ")}`).join(" → ") || "none"}
        </div>
      )}
      {foldSteps ? (
        <details className="sp-steps-fold" data-testid="system-plan-steps" open={stepsOpen}>
          <summary>
            {plural(view.steps.length, "step")} in {plural(repos.length, "repository", "repositories")}
          </summary>
          {tables}
        </details>
      ) : (
        <>
          {tables}
          {view.steps.length === 0 ? <div className="faint">The plan has no step yet.</div> : null}
          <div className="faint">
            {plural(view.steps.length, "step")} in {plural(repos.length, "repository", "repositories")}
          </div>
        </>
      )}
    </>
  );
}
