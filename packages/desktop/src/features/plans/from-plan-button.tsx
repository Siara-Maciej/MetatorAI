/**
 * A plan view's "Create Backlog item" (round 17): the plan, not run yet, lives in the Backlog as
 * a parent item with a child per step or phase (`POST /issues/from-plan`). Once made, the button
 * opens that item instead. Works on a plan run and on a system run.
 *
 * Without the screen's action, the button keeps its own in a PlanAction store (ADR-0113); the
 * Backlog's items are read only for what the button says.
 */

import { readAgainNow, useDaemon, useDaemonStore, usePolledSelect } from "../../shared/daemon/daemon.tsx";
import type { Action } from "../../shared/hooks.ts";
import { navigate } from "../../shared/navigation.ts";
import { Button } from "../../ui/button.tsx";
import { CREATE_ITEM, fromPlanButton } from "../backlog/model.ts";
import { PlanActionNotice, PlanActionScope, usePlanStoreAction } from "./plan-action.tsx";

interface Of {
  /** The plan run, or the system run whose plan it is. */
  readonly runId: string;
  readonly repo: string | undefined;
}

export function FromPlanButton({
  runId,
  repo,
  action,
}: Of & {
  /** The screen's own action (its notice); else the button keeps its own. */
  readonly action?: Action | undefined;
}) {
  return action ? (
    <FromPlan runId={runId} repo={repo} action={action} />
  ) : (
    <PlanActionScope>
      <OwnFromPlan runId={runId} repo={repo} />
    </PlanActionScope>
  );
}

const itemsKey = (repo: string | undefined) => `from-plan:${repo ?? ""}`;

function OwnFromPlan({ runId, repo }: Of) {
  const daemon = useDaemonStore();
  const action = usePlanStoreAction(() => readAgainNow(daemon.getState().url, itemsKey(repo)));
  return (
    <>
      <FromPlan runId={runId} repo={repo} action={action} />
      <PlanActionNotice />
    </>
  );
}

function FromPlan({ runId, repo, action }: Of & { readonly action: Action }) {
  const { client, setRepo, repos } = useDaemon("client", "setRepo", "repos");
  const button = usePolledSelect(
    itemsKey(repo),
    () => client.issues(repo),
    5000,
    (d) => (d ? fromPlanButton(d.issues, runId) : undefined),
  );
  const open = (id: string) => {
    if (repo && repos.length > 0) setRepo(repo);
    navigate({ screen: "backlog", id });
  };
  const create = () =>
    action.run(
      async (by) => {
        const r = await client.issueFromPlan({ runId, by }, repo);
        if (r.ok && r.data) open(r.data.parent.id);
        return r;
      },
      { who: true, refused: "no Backlog item was made" },
    );
  const shown = button ?? fromPlanButton([], runId);
  return (
    <Button
      data-testid="from-plan"
      disabled={action.busy || !button}
      title={
        shown.label === CREATE_ITEM
          ? "The plan as a Backlog item: one parent, a part per step or phase, each started on its own"
          : undefined
      }
      onClick={() => (shown.itemId ? open(shown.itemId) : void create())}
    >
      {shown.label}
    </Button>
  );
}
