/**
 * A plan view's "Create Backlog item" (round 17): the plan, not run yet, lives in the Backlog as
 * a parent item with a child per step or phase (`POST /issues/from-plan`). Once made, the button
 * opens that item instead. Works on a plan run and on a system run.
 */
import { CREATE_ITEM, fromPlanButton } from "../backlog.ts";
import { useDaemon, usePolled } from "../daemon.tsx";
import { type Action, useAction } from "../hooks.ts";
import { routeHash } from "../model.ts";
import { Notice } from "./common.tsx";

export function FromPlanButton({
  runId,
  repo,
  action: outer,
}: {
  /** The plan run, or the system run whose plan it is. */
  readonly runId: string;
  readonly repo: string | undefined;
  /** The screen's own action (its notice); else the button keeps its own. */
  readonly action?: Action | undefined;
}) {
  const { client, setRepo, repos } = useDaemon();
  const items = usePolled(`from-plan:${repo ?? ""}`, () => client.issues(repo), 5000);
  const own = useAction(items.reload);
  const action = outer ?? own;
  const button = fromPlanButton(items.data?.issues ?? [], runId);
  const open = (id: string) => {
    if (repo && repos.length > 0) setRepo(repo);
    window.location.hash = routeHash({ screen: "backlog", id });
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
  return (
    <>
      <button
        type="button"
        data-testid="from-plan"
        disabled={action.busy || !items.data}
        title={
          button.label === CREATE_ITEM
            ? "The plan as a Backlog item: one parent, a part per step or phase, each started on its own"
            : undefined
        }
        onClick={() => (button.itemId ? open(button.itemId) : void create())}
      >
        {button.label}
      </button>
      {outer ? null : <Notice {...own.notice} />}
    </>
  );
}
