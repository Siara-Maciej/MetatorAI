/**
 * The Overview of a task's page (level 2): how the task goes. The one thing to decide in it, if
 * any (the decision card of the first of its runs that asks); its flow and its steps by
 * repository (a system task's plan, read-only); for a run with child runs, its child runs by
 * repository. Each step leads to its own page.
 */
import { Glyph } from "../../shared/components/glyph.tsx";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { useTasks } from "../../shared/hooks.ts";
import { blockedReason, firstLevel, lookOf } from "../../shared/model/look.ts";
import { decisionKey } from "../../shared/model/needs.ts";
import { sameRepo } from "../../shared/model/places.ts";
import { routeHash } from "../../shared/model/route.ts";
import type { Run } from "../../shared/model/runs.ts";
import { systemPlanOf } from "../../shared/model/system-plans.ts";
import { subtasksByRepo, type WorkTask } from "../../shared/model/tasks.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { DecisionCard } from "../inbox/decision-card.tsx";
import { SystemPlanPanel } from "../plans/system-plan.tsx";
import { TaskSaid, useTaskSaid } from "./run-parts-state.ts";

export function TaskOverview({
  run,
  onOpenRun,
  onOpenChanges,
}: {
  readonly run: Run;
  onOpenRun(runId: string): void;
  onOpenChanges(runId: string): void;
}) {
  return (
    <ScopeProvider store={TaskSaid} init={undefined}>
      <div className="task-page" data-testid="task-page">
        <ToDecide run={run} onOpenRun={onOpenRun} onOpenChanges={onOpenChanges} />
        <TaskPlan run={run} onOpenRun={onOpenRun} />
        <OwnSteps run={run} />
      </div>
    </ScopeProvider>
  );
}

/** The task's own parent task (a system or parent task headed by this run), if any. */
function useOwnTask(run: Run): WorkTask | undefined {
  const tasks = useTasks();
  return tasks.find((t) => (t.kind === "system" || t.kind === "parent") && t.head?.runId === run.runId);
}

/** The decision of the first of its runs that asks, if any. */
function useAsking(run: Run, own: WorkTask | undefined) {
  const { inbox } = useDaemon("inbox");
  const mine = new Set([run.runId, ...(own?.subtasks.flatMap((c) => (c.runId ? [c.runId] : [])) ?? [])]);
  return inbox.find((i) => mine.has(i.runId));
}

/** The one thing to decide in the task, or what was answered here, or nothing. */
function ToDecide({
  run,
  onOpenRun,
  onOpenChanges,
}: {
  readonly run: Run;
  onOpenRun(runId: string): void;
  onOpenChanges(runId: string): void;
}) {
  const own = useOwnTask(run);
  const item = useAsking(run, own);
  const said = useTaskSaid((s) => s.said);
  const answered = useTaskSaid((s) => s.answered);
  return (
    <section className="box decide" aria-label="to decide" data-testid="task-decide">
      <h3>To decide</h3>
      {item ? (
        <div className="dim" data-testid="task-decide-who">
          {item.runId === run.runId
            ? "The task itself asks:"
            : `${own?.subtasks.find((c) => c.runId === item.runId)?.title ?? item.runId} asks:`}{" "}
          <a href={routeHash({ screen: "run", runId: item.runId, tab: "overview" })}>its page ›</a>{" "}
          <a href={routeHash({ screen: "inbox", pick: decisionKey(item) })} data-testid="decision-link">
            on Home ›
          </a>
        </div>
      ) : null}
      {item ? (
        <DecisionCard
          key={`${item.runId}/${item.question.id}`}
          item={item}
          onAnswered={answered}
          onOpenSession={(id) => onOpenRun(id)}
          onOpenChanges={onOpenChanges}
        />
      ) : (
        <div className="muted">{said ?? "Nothing waits for you in this task."}</div>
      )}
    </section>
  );
}

/** A system task's plan, read-only; none while its approval card holds it in full. */
function TaskPlan({ run, onOpenRun }: { readonly run: Run; onOpenRun(runId: string): void }) {
  const own = useOwnTask(run);
  const item = useAsking(run, own);
  const { systemPlans, runs } = useDaemon("systemPlans", "runs");
  const system = systemPlanOf(systemPlans, run, runs);
  // The system plan's own approval card holds the plan in full with its flow: drawn once.
  const planOnCard = item?.runId === run.runId && item.question.source === "gate";
  return planOnCard ? null : system ? (
    <SystemPlanPanel planId={system.plan.id} repo={system.repo} onOpenRun={onOpenRun} />
  ) : /system/.test(run.workflow) ? (
    <SystemPlanPanel planOfRun={run} repo={run.repo} onOpenRun={onOpenRun} />
  ) : null;
}

/** A parent run's child runs (not a system task's: its plan shows them). */
function OwnSteps({ run }: { readonly run: Run }) {
  const own = useOwnTask(run);
  const { systemPlans, runs } = useDaemon("systemPlans", "runs");
  const system = systemPlanOf(systemPlans, run, runs);
  return own && !system && !/system/.test(run.workflow) ? <TaskSteps task={own} /> : null;
}

/** A task's child runs by repository: the first level's word, and why one is blocked. */
function TaskSteps({ task }: { readonly task: WorkTask }) {
  const { runs } = useDaemon("runs");
  return (
    <section className="box task-steps" aria-label="its steps" data-testid="task-steps">
      <h3>Its steps</h3>
      {subtasksByRepo(task).map((g) => (
        <div key={g.repo || "."} className="task-repo">
          <div className="repo-name">{g.repo || "this repository"}</div>
          {g.cards.map((c) => {
            const r = c.runId ? runs.find((x) => x.runId === c.runId && sameRepo(x.repo, c.repo)) : undefined;
            const word = c.needsYou ? "needs you" : firstLevel(c.state);
            return (
              <div key={c.key} className="step-line">
                <Glyph kind="first" state={word} />{" "}
                {r ? (
                  <a href={routeHash({ screen: "run", runId: r.runId, tab: "overview" })}>{c.title}</a>
                ) : (
                  <span>{c.title}</span>
                )}{" "}
                <span className={lookOf("first", word).tone}>{word}</span>
                <span className="faint">
                  {" "}
                  · {word === "blocked" ? blockedReason({ run: r, waitsFor: c.waitsFor }) : (r?.stage ?? "")}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
