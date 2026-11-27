/**
 * Overview → System: the system plans of the repository (one opens with its steps, its approval
 * and its editing), the system map (applications and contracts, edited like a plan), where the
 * applications' code is on this machine (`system.roots`), and "Discover": what the code shows
 * that the map lacks, previewed before it is written.
 *
 * The row chosen is the SystemChoice store's (ADR-0113): a row reads its own plan and whether it
 * is the one chosen, so a choice draws two rows and the detail again, not the list.
 */
import type { SystemPlanSummary } from "../../shared/api/api.ts";
import { useDaemon, useDaemonStore, usePolled, usePolledSelect } from "../../shared/daemon/daemon.tsx";
import { plural } from "../../shared/model/format.ts";
import { lookOf } from "../../shared/model/look.ts";
import { navigate } from "../../shared/navigation.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { EmptyRow, ListRow, ListSection } from "../../ui/list-detail.tsx";
import { SystemPlanPanel } from "../plans/system-plan.tsx";
import { SystemMapEditor } from "./system-map-editor.tsx";
import { SystemChoice, useSystemChoice } from "./system-state.ts";

const PLAN_LOOK: Record<string, string> = {
  draft: "todo",
  approved: "blocked",
  running: "in-progress",
  done: "done",
};

export function SystemPanel({ onOpenRun }: { onOpenRun(runId: string): void }) {
  return (
    <ScopeProvider store={SystemChoice} init={undefined}>
      <div className="system-tab" data-testid="overview-system">
        <div className="ld-body system-body">
          <aside className="ld-list" aria-label="system plans">
            <PlanRows />
            <span className="spacer" />
            <ListSection>the system</ListSection>
            <MapRow />
          </aside>
          <section className="ld-detail">
            <Detail onOpenRun={onOpenRun} />
          </section>
        </div>
      </div>
    </ScopeProvider>
  );
}

const NO_PLANS: readonly SystemPlanSummary[] = [];

/** The repository's system plans, or `select`'s part of them (an empty list before the first answer). */
function usePlans<R>(select: (plans: readonly SystemPlanSummary[], read: boolean) => R): R {
  const { client, repo } = useDaemon("client", "repo");
  return usePolledSelect(
    `system-plans-all:${repo ?? ""}`,
    () => client.systemPlans(repo),
    5000,
    (d) => select(Array.isArray(d) ? d : NO_PLANS, d !== undefined),
  );
}

function PlanRows() {
  const { client, repo } = useDaemon("client", "repo");
  const list = usePolled(`system-plans-all:${repo ?? ""}`, () => client.systemPlans(repo), 5000);
  const ids = usePlans((plans) => plans.map((p) => p.id));
  return (
    <>
      <ListSection>system plans · {ids.length}</ListSection>
      {ids.map((id) => (
        <PlanRow key={id} id={id} />
      ))}
      {list.error && !list.data ? (
        <EmptyRow>The system plans could not be read: {list.error}</EmptyRow>
      ) : null}
      {list.data && ids.length === 0 ? (
        <EmptyRow>No system plan yet. A run of the workflow mt-system-change writes one.</EmptyRow>
      ) : null}
    </>
  );
}

function PlanRow({ id }: { readonly id: string }) {
  const p = usePlans((plans) => plans.find((x) => x.id === id));
  const selected = useSystemChoice((s) => s.chosen === id);
  const choose = useSystemChoice((s) => s.choose);
  const daemon = useDaemonStore();
  if (!p) return null;
  return (
    <ListRow
      className="item"
      selected={selected}
      onSelect={() => {
        // A plan's page is its system run's: the row opens it there (its flow, steps and runs).
        const head = daemon.getState().runs.find((r) => /system/.test(r.workflow) && r.task === p.task);
        if (head) navigate({ screen: "run", runId: head.runId, tab: "overview" });
        else choose(p.id);
      }}
      testId={`system-plan-${p.id}`}
      glyph={
        <span className={`g ${lookOf("step", PLAN_LOOK[p.status]).tone ?? ""}`}>
          {lookOf("step", PLAN_LOOK[p.status]).glyph}
        </span>
      }
      title={p.task}
      sub={`${p.id} · ${p.status} · ${p.done}/${plural(p.steps, "step")}${p.approval?.stale ? " · approval stale" : ""}`}
    />
  );
}

function MapRow() {
  const selected = useSystemChoice((s) => s.chosen === "map");
  const choose = useSystemChoice((s) => s.choose);
  return (
    <ListRow
      className="item"
      selected={selected}
      onSelect={() => choose("map")}
      testId="system-map-row"
      glyph={<span className="g faint">◇</span>}
      title="System map"
      sub="applications, contracts, where the code is"
    />
  );
}

/** The map, or a plan whose system run is not here (another repository's, or gone), shown as it is. */
function Detail({ onOpenRun }: { onOpenRun(runId: string): void }) {
  const chosen = useSystemChoice((s) => s.chosen);
  const current = usePlans((plans) => plans.find((p) => p.id === chosen)?.id);
  const { repo } = useDaemon("repo");
  return chosen === "map" || !current ? (
    <SystemMapEditor />
  ) : (
    <SystemPlanPanel planId={current} repo={repo} onOpenRun={onOpenRun} flow={false} />
  );
}
