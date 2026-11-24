/**
 * Overview → System: the system plans of the repository (one opens with its steps, its approval
 * and its editing), the system map (applications and contracts, edited like a plan), where the
 * applications' code is on this machine (`system.roots`), and "Discover": what the code shows
 * that the map lacks, previewed before it is written.
 */
import { useState } from "react";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { plural } from "../../shared/model/format.ts";
import { lookOf } from "../../shared/model/look.ts";
import { navigate } from "../../shared/navigation.ts";
import { EmptyRow, ListRow, ListSection } from "../../ui/list-detail.tsx";
import { SystemPlanPanel } from "../plans/system-plan.tsx";
import { SystemMapEditor } from "./system-map-editor.tsx";

const PLAN_LOOK: Record<string, string> = {
  draft: "todo",
  approved: "blocked",
  running: "in-progress",
  done: "done",
};
export function SystemPanel({ onOpenRun }: { onOpenRun(runId: string): void }) {
  const { client, repo, runs } = useDaemon("client", "repo", "runs");
  const list = usePolled(`system-plans-all:${repo ?? ""}`, () => client.systemPlans(repo), 5000);
  const [chosen, setChosen] = useState<string>();
  const plans = Array.isArray(list.data) ? list.data : [];
  const current = plans.find((p) => p.id === chosen);
  // A plan's page is its system run's: the row opens it there (its flow, steps and runs).
  const headOf = (task: string) => runs.find((r) => /system/.test(r.workflow) && r.task === task);
  return (
    <div className="system-tab" data-testid="overview-system">
      <div className="ld-body system-body">
        <aside className="ld-list" aria-label="system plans">
          <ListSection>system plans · {plans.length}</ListSection>
          {plans.map((p) => (
            <ListRow
              key={p.id}
              className="item"
              selected={current?.id === p.id}
              onSelect={() => {
                const head = headOf(p.task);
                if (head) navigate({ screen: "run", runId: head.runId, tab: "overview" });
                else setChosen(p.id);
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
          ))}
          {list.error && !list.data ? (
            <EmptyRow>The system plans could not be read: {list.error}</EmptyRow>
          ) : null}
          {list.data && plans.length === 0 ? (
            <EmptyRow>No system plan yet. A run of the workflow mt-system-change writes one.</EmptyRow>
          ) : null}
          <span className="spacer" />
          <ListSection>the system</ListSection>
          <ListRow
            className="item"
            selected={chosen === "map"}
            onSelect={() => setChosen("map")}
            testId="system-map-row"
            glyph={<span className="g faint">◇</span>}
            title="System map"
            sub="applications, contracts, where the code is"
          />
        </aside>
        <section className="ld-detail">
          {chosen === "map" || !current ? (
            <SystemMapEditor />
          ) : (
            // A plan whose system run is not here (another repository's, or gone): shown as it is.
            <SystemPlanPanel planId={current.id} repo={repo} onOpenRun={onOpenRun} flow={false} />
          )}
        </section>
      </div>
    </div>
  );
}
