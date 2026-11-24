/**
 * A system plan step's detail (round 17), opened by a click on its tile in the flow or on its card
 * on the Board: what the step already has (summary, app, contracts, what it waits for, its app's
 * files from the system analysis), "Plan this step" on demand (its child run `--until plan`, in a
 * terminal the app shows at once), and once planned its plan with a link to its run. The planner
 * never plans every step up front; a plan changes only through its agent.
 */

import type { SystemPlanView } from "../../shared/api/api.ts";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { useAction } from "../../shared/hooks.ts";
import { routeHash } from "../../shared/model/route.ts";
import { navigate } from "../../shared/navigation.ts";
import { Modal } from "../../ui/modal.tsx";
import { Notice } from "../../ui/notice.tsx";
import { FILES_UNKNOWN, itemOfStep, shownRoute, stepDetail, stepsOfView } from "../backlog/model.ts";

export function StepDetailDialog({
  view,
  stepId,
  repo,
  onClose,
}: {
  readonly view: SystemPlanView;
  readonly stepId: string;
  /** The repository whose daemon keeps the system plan. */
  readonly repo: string | undefined;
  onClose(): void;
}) {
  const { client } = useDaemon("client");
  const action = useAction();
  // The plan's view is polled by its page: the step's plan run and its plan come with it.
  const d = stepDetail({ steps: stepsOfView(view) }, stepId);
  // Its Backlog part, when the plan was put in the Backlog.
  const items = usePolled(`step-items:${repo ?? ""}`, () => client.issues(repo), 5000);
  const part = itemOfStep(items.data?.issues ?? [], view.plan.id, stepId);
  if (!d) return null;
  const planRun = d.planRunId;
  const go = (route: ReturnType<typeof shownRoute>) => {
    if (!route) return;
    onClose();
    navigate(route);
  };
  const planIt = () =>
    action.run(
      async (by) => {
        const r = await client.planSystemStep(view.plan.id, d.id, { by }, repo);
        // Its planner's terminal, at once (as "+ New chat" opens its thread).
        if (r.ok && r.data) go(shownRoute({ runId: r.data.run, paneId: r.data.session?.paneId }));
        return r;
      },
      { who: true, refused: "the step's plan did not start" },
    );
  const lines = d.planLines;
  const facts: [string, string][] = [
    ["app", d.app],
    ["contracts", d.contracts.join(", ") || "none"],
    ["after", d.after.join(" · ") || "nothing: it can start first"],
  ];
  return (
    <Modal label={`step ${d.summary}`} className="dialog step-detail" closeOnBackdrop onClose={onClose}>
      <div className="viewer-head">
        <h2>{d.summary}</h2>
        <span className={`chip ${WORD_TONE[d.word]}`} data-testid="step-word">
          {d.word}
        </span>
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div data-testid="step-detail">
        <dl className="facts">
          {facts.map(([name, value]) => (
            <div className="row" key={name}>
              <dt className="dim">{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          <div className="row">
            <dt className="dim">files</dt>
            <dd className={d.files === FILES_UNKNOWN ? "faint" : "mono"} data-testid="step-files">
              {d.files === FILES_UNKNOWN ? "not known until planned" : d.files.join(", ")}
            </dd>
          </div>
        </dl>
        {planRun ? (
          <section className="step-own-plan" aria-label="its plan" data-testid="step-own-plan">
            <h3>Its plan</h3>
            {lines.length > 0 ? (
              <ul className="plain">
                {lines.map((l) => (
                  <li key={l} className="mono">
                    {l}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="faint">
                {d.word === "planning" ? "Its planner is writing it…" : "Its plan run wrote no plan."}
              </div>
            )}
          </section>
        ) : null}
        <Notice {...action.notice} />
        <div className="actions">
          {d.button ? (
            <button
              type="button"
              className="primary"
              disabled={action.busy || d.button.disabled !== undefined}
              title={d.button.disabled ?? "Its own plan, made by its planner in a terminal you can watch"}
              onClick={() => void planIt()}
            >
              {d.button.label}
            </button>
          ) : null}
          {planRun ? (
            <>
              <button type="button" onClick={() => go(shownRoute({ runId: planRun }))}>
                Its terminal
              </button>
              <a href={routeHash({ screen: "run", runId: planRun, tab: "overview" })} onClick={onClose}>
                its plan's run ›
              </a>
            </>
          ) : null}
          {d.run ? (
            <a href={routeHash({ screen: "run", runId: d.run, tab: "overview" })} onClick={onClose}>
              its run ›
            </a>
          ) : null}
          {part ? (
            <a href={routeHash({ screen: "backlog", id: part.id })} onClick={onClose}>
              its Backlog item ›
            </a>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/** The detail of a step known by its plan's id (a Board card): the plan is read first. */
export function StepDetailOf({
  planId,
  stepId,
  repo,
  onClose,
}: {
  readonly planId: string;
  readonly stepId: string;
  readonly repo: string | undefined;
  onClose(): void;
}) {
  const { client } = useDaemon("client");
  const view = usePolled(`system-plan:${repo ?? ""}:${planId}`, () => client.systemPlan(planId, repo), 3000);
  return view.data ? (
    <StepDetailDialog view={view.data} stepId={stepId} repo={repo} onClose={onClose} />
  ) : null;
}

const WORD_TONE: Readonly<Record<NonNullable<ReturnType<typeof stepDetail>>["word"], string>> = {
  pending: "",
  planning: "violet",
  planned: "teal",
  running: "violet",
  done: "green",
  blocked: "red",
};
