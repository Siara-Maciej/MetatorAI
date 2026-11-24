/**
 * "Retry this step": a step of a system plan whose child run was aborted is re-opened by a
 * person. The step is pending again (its old run kept in its history, the old worktree left for
 * a look); the system run, resumed or still waiting, starts a new child for it.
 */
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { useAction } from "../../shared/hooks.ts";
import type { Run } from "../../shared/model/runs.ts";
import { Notice } from "../../ui/notice.tsx";

/** The button on one step: shown only while its run is aborted. */
export function RetryStepButton({
  planId,
  step,
  repo,
  onRetried,
}: {
  readonly planId: string;
  readonly step: string;
  readonly repo: string | undefined;
  onRetried?: (() => void) | undefined;
}) {
  const { client } = useDaemon("client");
  const action = useAction(onRetried);
  return (
    <span className="retry-step">
      <button
        type="button"
        data-testid={`retry-step-${step}`}
        disabled={action.busy}
        onClick={() =>
          void action.run((by) => client.retrySystemStep(planId, step, by ?? "", repo), {
            who: true,
            done: `step ${step} is pending again: the system run starts a new child for it`,
            refused: "the step was not retried",
          })
        }
      >
        Retry this step
      </button>
      <Notice {...action.notice} />
    </span>
  );
}

/** On a system run's escalated card and bar: each step whose child run was aborted, with its Retry. */
export function RetryAbortedSteps({ run }: { readonly run: Run }) {
  const { client } = useDaemon("client");
  const system = run.workflow === "mt-system-change";
  const plans = usePolled(
    `retry-steps-of:${run.runId}`,
    () => (system ? client.systemPlans(run.repo) : Promise.resolve({ ok: true as const, data: [] })),
    system ? 5_000 : 0,
  );
  const id = plans.data?.find((p) => p.task === run.task)?.id;
  const view = usePolled(
    `retry-steps-plan:${id ?? ""}`,
    () => (id ? client.systemPlan(id, run.repo) : Promise.resolve({ ok: true as const, data: undefined })),
    id ? 5_000 : 0,
  );
  const aborted = (view.data?.steps ?? []).filter((s) => s.runState === "aborted");
  if (!id || aborted.length === 0) return null;
  return (
    <div className="retry-steps" data-testid="retry-aborted-steps">
      {aborted.map((s) => (
        <div key={s.id} className="retry-row">
          <span>
            step <span className="mono">{s.id}</span> in {s.app}: its run was aborted
          </span>{" "}
          <RetryStepButton planId={id} step={s.id} repo={run.repo} onRetried={view.reload} />
        </div>
      ))}
    </div>
  );
}
