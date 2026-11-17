/**
 * A system plan: one change across repositories. Its steps grouped by repository with the run
 * each started and that run's state (a click opens it), the waves as the deploy order, the
 * approval (stale once the plan changed), the lint, Approve (closed while the lint has errors,
 * with the reason), and the same editing as a run's plan: a step that already has a run is
 * history and stays as it is.
 */
import { useState } from "react";
import type { SystemPlan, SystemPlanView } from "../api.ts";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { clock, lookOf, plural, type Run, routeHash, sameRepo } from "../model.ts";
import {
  blankSystemStep,
  listOf,
  stepLocked,
  systemPlanChanges,
  textOf,
  withoutSystemStep,
  withSystemStep,
  withSystemStepChanged,
  withSystemStepMoved,
} from "../plan-edit.ts";
import { TextEditor } from "../run/plan-form.tsx";
import { Notice } from "./common.tsx";
import { type DocSource, EditBar, FieldProblems, ProblemList, useDocEditor } from "./doc-editor.tsx";

/** A repository as a person names it: the last part of its path. */
const repoName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

export function SystemPlanPanel({
  planId,
  planOfRun,
  repo,
  onOpenRun,
}: {
  /** The plan, by its id; or the system run whose plan it is (found by its task). */
  readonly planId?: string | undefined;
  readonly planOfRun?: Run | undefined;
  readonly repo: string | undefined;
  onOpenRun?: ((runId: string) => void) | undefined;
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
  return <SystemPlanBody id={id} repo={repo} onOpenRun={onOpenRun} />;
}

function SystemPlanBody({
  id,
  repo,
  onOpenRun,
}: {
  readonly id: string;
  readonly repo: string | undefined;
  onOpenRun?: ((runId: string) => void) | undefined;
}) {
  const { client, runs } = useDaemon();
  const plan = usePolled(`system-plan:${repo ?? ""}:${id}`, () => client.systemPlan(id, repo), 3000);
  const action = useAction(plan.reload);
  const source: DocSource<SystemPlanView, SystemPlan> = {
    view: plan.data,
    reload: plan.reload,
    docOf: (v) => v.plan,
    digestOf: (v) => v.digest,
    lintOf: (v) => v.lint,
    editable: (v) => v.editable,
    readOnlyBecause: (v) => v.readOnlyBecause,
    check: (p) => client.lintSystemPlan(id, p, repo),
    save: (p, digest, by) => client.saveSystemPlan(id, { plan: p, digest, by }, repo),
    changes: systemPlanChanges,
  };
  const editor = useDocEditor(source);
  const view = plan.data;
  if (!view) return <div className="empty">{plan.error ?? `reading the system plan ${id}…`}</div>;
  const errors = editor.problems.filter((p) => p.severity === "error");
  const approve = () =>
    action.run((by) => client.approveSystemPlan(id, by, repo), {
      who: true,
      refused: "the plan was not approved",
      done: "approved: its steps start in the deploy order",
    });
  const repos = [...new Set(view.steps.map((s) => s.repo))];
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
      <EditBar editor={editor} source={source} noun="system plan" testId="system-plan-edit-bar">
        {view.status === "draft" || view.approval?.stale ? (
          <button
            type="button"
            className="primary"
            disabled={errors.length > 0 || action.busy}
            title={errors.length > 0 ? `fix the lint first: ${errors[0]?.message}` : "approve the plan"}
            onClick={() => void approve()}
          >
            Approve
          </button>
        ) : null}
      </EditBar>
      {editor.mode === "view" && (view.status === "draft" || view.approval?.stale) && errors.length > 0 ? (
        <div className="amber" data-testid="approve-blocked">
          Approve waits until the lint has no error: {errors[0]?.message}
        </div>
      ) : null}
      <Notice {...action.notice} />
      {editor.mode === "text" ? (
        <TextEditor
          text={editor.text}
          label="the system plan as JSON"
          problems={editor.problems}
          onChange={editor.setText}
        />
      ) : editor.mode === "form" && editor.draft ? (
        <SystemPlanForm
          plan={editor.draft}
          view={view}
          onChange={editor.setDraft}
          problems={editor.problems}
        />
      ) : (
        <>
          <ProblemList problems={editor.problems} testId="system-plan-problems" />
          <section className="sp-waves" aria-label="deploy order">
            <h3>Deploy order</h3>
            {view.waves.length === 0 ? (
              <div className="faint">
                No order: the steps wait on each other in a circle (the lint says where).
              </div>
            ) : (
              <ol>
                {view.waves.map((w) => (
                  <li key={w.wave}>
                    wave {w.wave}: <span className="mono">{w.steps.join(", ")}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
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
    </div>
  );
}

function SystemPlanForm({
  plan,
  view,
  problems,
  onChange,
}: {
  readonly plan: SystemPlan;
  readonly view: SystemPlanView;
  readonly problems: SystemPlanView["lint"]["problems"];
  onChange(change: (p: SystemPlan) => SystemPlan): void;
}) {
  const apps = [...new Set(view.steps.map((s) => s.app).concat(plan.steps.map((s) => s.app)))].filter(
    (a) => a !== "",
  );
  const [newApp, setNewApp] = useState(apps[0] ?? "");
  return (
    <div className="plan-form" data-testid="system-plan-form">
      <label className="pf-field wide">
        <span>Task</span>
        <input
          aria-label="system plan task"
          value={plan.task}
          onChange={(e) => onChange((p) => ({ ...p, task: e.target.value }))}
        />
      </label>
      <ol className="pf-steps">
        {plan.steps.map((s, i) => {
          const locked = stepLocked(s);
          const mine = problems.filter((p) => p.step === s.id);
          return (
            <li
              key={s.id}
              className={locked ? "pf-step locked" : "pf-step"}
              aria-label={`step ${s.id}`}
              data-testid={`system-plan-step-${s.id}`}
              onKeyDown={(e) => {
                if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                e.preventDefault();
                onChange((p) => withSystemStepMoved(p, s.id, e.key === "ArrowUp" ? -1 : 1));
              }}
            >
              <div className="pf-head">
                <b className="mono">{s.id}</b>
                <span className="faint">
                  {locked ? `has a run (${s.run}): kept as it is` : `step ${i + 1} of ${plan.steps.length}`}
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="ghost"
                  aria-label={`move ${s.id} up`}
                  disabled={i === 0}
                  onClick={() => onChange((p) => withSystemStepMoved(p, s.id, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="ghost"
                  aria-label={`move ${s.id} down`}
                  disabled={i === plan.steps.length - 1}
                  onClick={() => onChange((p) => withSystemStepMoved(p, s.id, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="ghost"
                  aria-label={`remove ${s.id}`}
                  disabled={locked}
                  title={locked ? "a step that has a run cannot be removed" : undefined}
                  onClick={() => onChange((p) => withoutSystemStep(p, s.id))}
                >
                  ✕
                </button>
              </div>
              <ProblemList problems={mine} />
              <div className="pf-grid">
                <label className="pf-field">
                  <span>Application</span>
                  <input
                    aria-label={`${s.id} application`}
                    className="mono"
                    value={s.app}
                    disabled={locked}
                    onChange={(e) => onChange((p) => withSystemStepChanged(p, s.id, { app: e.target.value }))}
                  />
                </label>
                <label className="pf-field wide">
                  <span>What it does</span>
                  <input
                    aria-label={`${s.id} summary`}
                    value={s.summary}
                    disabled={locked}
                    onChange={(e) =>
                      onChange((p) => withSystemStepChanged(p, s.id, { summary: e.target.value }))
                    }
                  />
                </label>
                <label className="pf-field">
                  <span>After</span>
                  <input
                    aria-label={`${s.id} after`}
                    className="mono"
                    value={textOf(s.dependsOn)}
                    disabled={locked}
                    onChange={(e) =>
                      onChange((p) => withSystemStepChanged(p, s.id, { dependsOn: listOf(e.target.value) }))
                    }
                  />
                  <FieldProblems problems={mine.filter((p) => (p.field ?? "").endsWith("dependsOn"))} />
                </label>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="row">
        <label className="pf-field">
          <span>New step in</span>
          <input
            aria-label="application of the new step"
            className="mono"
            value={newApp}
            onChange={(e) => setNewApp(e.target.value)}
          />
        </label>
        <button type="button" onClick={() => onChange((p) => withSystemStep(p, blankSystemStep(p, newApp)))}>
          + Step
        </button>
      </div>
    </div>
  );
}
