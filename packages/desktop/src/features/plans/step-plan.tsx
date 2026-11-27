/**
 * A step's plan, read-only, on its Overview (there is no Plan tab): where the run stands and what is left. The stages
 * in one line, the plan's steps on the left with their live state, one step on the right with
 * its file, tests, exemplar and rules, what waits for a person at the top, what comes next and
 * the artifacts below, the last events at the bottom. Everything comes from `GET /runs/:id/board`.
 *
 * The step chosen is the ChosenStep store's (ADR-0113); each part reads only its piece of the
 * board or of the plan, and a step's row only whether it is the one shown.
 */

import type { PlanBoardView, PlanLintProblem, RunPlanView } from "../../shared/api/api.ts";
import { Glyph } from "../../shared/components/glyph.tsx";
import { StageBar } from "../../shared/components/stage-bar.tsx";
import {
  readAgainNow,
  useDaemon,
  useDaemonStore,
  usePolled,
  usePolledSelect,
} from "../../shared/daemon/daemon.tsx";
import { clock, duration, lintSummary, plural } from "../../shared/model/format.ts";
import type { Run } from "../../shared/model/runs.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyRow, ListDetail, ListRow, ListSection } from "../../ui/list-detail.tsx";
import { QuickAnswer } from "../inbox/answer.tsx";
import { ActivityList } from "../runs/activity-list.tsx";
import { problemsAt } from "../runs/model.ts";
import { FieldProblems, ProblemList } from "./doc-editor.tsx";
import { FromPlanButton } from "./from-plan-button.tsx";
import { PlanChanges } from "./plan-changes.tsx";
import { planLintShown } from "./plan-edit.ts";
import { ChosenStep, useChosenStep } from "./plans-state.ts";

const or = (items: readonly string[]): string => (items.length > 0 ? items.join(", ") : "—");

interface Of {
  readonly runId: string;
  readonly repo: string | undefined;
}

type OpenPane = (paneId: string, runId: string) => void;
type OpenRun = (runId: string, attach?: boolean) => void;

export function StepPlan({
  run,
  runId,
  onOpenPane,
  onOpenRun,
  asks = true,
}: {
  /** Show what waits for the person here too; the Overview shows it once, above the plan. */
  readonly asks?: boolean;
  /** The run from the state; the board is read for a run the state no longer lists too. */
  readonly run: Run | undefined;
  readonly runId: string;
  /** Shows a pane in Terminals (the step's worker). */
  onOpenPane: OpenPane;
  /** The run's Terminal tab, with the keyboard taken when asked. */
  onOpenRun: OpenRun;
}) {
  const of = { runId, repo: run?.repo };
  const read = useBoard(of, (b) => b !== undefined);
  if (!read) return <BoardReading {...of} />;
  return (
    <ScopeProvider store={ChosenStep} init={undefined}>
      <div className="plan-view">
        <LintBar {...of} topRun={!run?.parent} />
        <PlanChangesOf {...of} />
        <ListDetail
          className="plan"
          testId="plan"
          top={<Stages {...of} />}
          listLabel="steps of the plan"
          list={<StepList {...of} asks={asks} />}
        >
          <BoardError {...of} />
          <PlanProblems {...of} />
          {asks ? <AskLine {...of} onOpenRun={onOpenRun} /> : null}
          <ShownStep {...of} onOpenPane={onOpenPane} />
          <div className="cols">
            <div>
              <ListSection>what comes next</ListSection>
              <Next {...of} />
              <Gates {...of} />
              <Resumes {...of} />
            </div>
            <Workers {...of} onOpenPane={onOpenPane} />
          </div>
          <span className="spacer" />
          <LastEvents {...of} />
        </ListDetail>
      </div>
    </ScopeProvider>
  );
}

/* ---------- what the daemon says ---------- */

const boardKey = ({ runId, repo }: Of) => `plan:${repo ?? ""}:${runId}`;
const plannedKey = ({ runId, repo }: Of) => `run-plan:${repo ?? ""}:${runId}`;

/** The run's board, or `select`'s part of it (undefined before the first answer). */
function useBoard<R>(of: Of, select: (board: PlanBoardView | undefined) => R): R {
  const { client } = useDaemon("client");
  return usePolledSelect(boardKey(of), () => client.board(of.runId, of.repo), 2000, select);
}

/** The plan as a document (its lint, its changes), or `select`'s part of it. */
function usePlanned<R>(of: Of, select: (planned: RunPlanView | undefined) => R): R {
  const { client } = useDaemon("client");
  return usePolledSelect(plannedKey(of), () => client.runPlan(of.runId, of.repo), 3000, select);
}

const NO_PROBLEMS: readonly PlanLintProblem[] = [];
const useProblems = (of: Of) => usePlanned(of, (p) => p?.lint.problems ?? NO_PROBLEMS);

/** The step shown on the right: the one chosen, else the one in progress, else the first. */
function useShownId(of: Of): string | undefined {
  const chosen = useChosenStep((s) => s.chosen);
  return useBoard(of, (b) => {
    const steps = b?.plan?.steps ?? [];
    return (steps.find((s) => s.id === chosen) ?? steps.find((s) => s.state === "in-progress") ?? steps[0])
      ?.id;
  });
}

function BoardReading(of: Of) {
  const { client } = useDaemon("client");
  const { error } = usePolled(boardKey(of), () => client.board(of.runId, of.repo), 2000);
  return <div className="empty">{error ?? `reading the plan of ${of.runId}…`}</div>;
}

function BoardError(of: Of) {
  const { client } = useDaemon("client");
  const { error } = usePolled(boardKey(of), () => client.board(of.runId, of.repo), 2000);
  return error ? <div className="banner">{error}</div> : null;
}

/* ---------- above the list ---------- */

/** The plan's lint, with who writes it; a plan file that does not fit its format says where. */
function LintBar({ topRun, ...of }: Of & { readonly topRun: boolean }) {
  const { client } = useDaemon("client");
  const planned = usePolled(plannedKey(of), () => client.runPlan(of.runId, of.repo), 3000);
  const hasPlan = useBoard(of, (b) => b?.plan !== undefined);
  const problems = planned.data?.lint.problems ?? [];
  const errors = problems.filter((p) => p.severity === "error");
  // A workflow with no plan stage has no plan to lint: no bar, rather than "no problems".
  const lint = planLintShown(planned.data, hasPlan) ? planned.data?.lint : undefined;
  return lint ? (
    <div className="lint-bar" data-testid="plan-lint-bar">
      <span className={errors.length > 0 ? "red" : problems.length > 0 ? "amber" : "green"}>
        lint: {lintSummary(lint)}
      </span>
      <span className="faint">
        {" "}
        · the planner writes this plan; ask it for changes on the plan's approval card
      </span>
      <span className="spacer" />
      {/* A top run's plan can live in the Backlog, not run yet (round 17). */}
      {hasPlan && topRun ? <FromPlanButton runId={of.runId} repo={of.repo} /> : null}
    </div>
  ) : planned.error ? (
    // A plan file that does not fit its format: the daemon says where.
    <div className="banner" data-testid="plan-unreadable">
      The plan cannot be read: {planned.error}
    </div>
  ) : null;
}

function PlanChangesOf(of: Of) {
  const changes = usePlanned(of, (p) => p?.changes);
  const previousAt = usePlanned(of, (p) => p?.previous?.at);
  return <PlanChanges changes={changes} previousAt={previousAt} />;
}

function Stages(of: Of) {
  const stages = useBoard(of, (b) => b?.stages ?? []);
  return (
    <>
      <span className="faint">Stages</span>
      <StageBar stages={stages} variant="strip" titleOf={stageTitle} testId="plan-stages" />
    </>
  );
}

/* ---------- the list ---------- */

const NO_IDS: readonly string[] = [];

function StepList({ asks, ...of }: Of & { readonly asks: boolean }) {
  const ids = useBoard(of, (b) => b?.plan?.steps.map((s) => s.id) ?? NO_IDS);
  const count = useBoard(of, (b) => (b?.plan ? `${b.plan.done}/${b.plan.steps.length}` : "no plan yet"));
  const hasPlan = useBoard(of, (b) => b?.plan !== undefined);
  return (
    <>
      <ListSection>steps · {count}</ListSection>
      {ids.map((id, i) => (
        <StepRow key={id} {...of} id={id} n={i + 1} />
      ))}
      {hasPlan ? null : (
        <EmptyRow>The plan stage writes plan.json; the steps appear here as it does.</EmptyRow>
      )}
      <span className="spacer" />
      {asks ? <WaitingList {...of} /> : null}
    </>
  );
}

/** One step of the plan: it reads its own step and whether it is the one shown. */
function StepRow({ id, n, ...of }: Of & { readonly id: string; readonly n: number }) {
  const s = useBoard(of, (b) => b?.plan?.steps.find((x) => x.id === id));
  const selected = useShownId(of) === id;
  const problems = usePlanned(of, (p) => problemsAt(p?.lint.problems ?? NO_PROBLEMS, id).length);
  const choose = useChosenStep((st) => st.choose);
  if (!s) return null;
  return (
    <ListRow
      className="step"
      selected={selected}
      onSelect={() => choose(id)}
      glyph={<Glyph kind="step" state={s.state} />}
      title={`${n} ${s.intent}`}
      sub={`${s.path}${s.evidence && s.state === "done" ? ` · ${s.evidence.split(": ")[1] ?? s.evidence}` : ""}${
        problems > 0 ? ` · ⚠ ${plural(problems, "problem")}` : ""
      }`}
      trailing={<span className="dim">{s.worker?.name ?? ""}</span>}
    />
  );
}

function WaitingList(of: Of) {
  const waiting = useBoard(of, (b) => b?.waiting ?? []);
  return waiting.length > 0 ? (
    <>
      <ListSection>waits for you · {waiting.length}</ListSection>
      {waiting.map((q) => (
        <ListRow
          key={q.id}
          className="step"
          glyph={<Glyph kind="step" state="waiting" />}
          title={
            <span className="clamp" title={q.prompt}>
              {q.prompt}
            </span>
          }
          trailing={<span className="dim">{duration(Date.now() - new Date(q.askedAt).getTime())}</span>}
        />
      ))}
    </>
  ) : null;
}

/* ---------- the right side ---------- */

function PlanProblems(of: Of) {
  const problems = useProblems(of);
  return <ProblemList problems={problems.filter((p) => p.step === undefined)} testId="plan-problems" />;
}

/** What waits for the person first, with its answer. */
function AskLine({ onOpenRun, ...of }: Of & { onOpenRun: OpenRun }) {
  const waiting = useBoard(of, (b) => b?.waiting[0]);
  const daemon = useDaemonStore();
  if (!waiting) return null;
  return (
    <div className="ask" data-testid="plan-ask">
      <span className="clamp" title={waiting.prompt}>
        <span className="amber">?</span> {waiting.agent ?? waiting.source} asks: <b>{waiting.prompt}</b>{" "}
        <span className="dim">· {duration(Date.now() - new Date(waiting.askedAt).getTime())}</span>
      </span>
      <span className="spacer" />
      {waiting.source === "permission" ? (
        <Button variant="primary" onClick={() => onOpenRun(of.runId, true)}>
          Answer in the pane
        </Button>
      ) : (
        <QuickAnswer
          question={waiting}
          repo={of.repo}
          onDone={() => void readAgainNow(daemon.getState().url, boardKey(of))}
        />
      )}
    </div>
  );
}

/** The step shown: its file, tests, exemplar, rules and what it waits for, each with its problems. */
function ShownStep({ onOpenPane, ...of }: Of & { onOpenPane: OpenPane }) {
  const id = useShownId(of);
  const step = useBoard(of, (b) => b?.plan?.steps.find((s) => s.id === id));
  const n = useBoard(of, (b) => (b?.plan?.steps.findIndex((s) => s.id === id) ?? -1) + 1);
  const exemplar = usePlanned(of, (p) => p?.plan?.steps.find((s) => s.id === id)?.patternSource?.exemplar);
  const stage = useBoard(of, (b) => b?.stage);
  const status = useBoard(of, (b) => b?.status);
  const problems = useProblems(of);
  if (!step)
    return (
      <h4 className="dim">
        {stage} · {status}
      </h4>
    );
  const facts: [string, string, string][] = [
    ["file", "path", `${step.action} ${step.path}`],
    ["tests first", "testsFirst", or(step.testsFirst)],
    ["exemplar", "exemplar", exemplar ?? step.exemplar ?? "—"],
    ["rules", "rules", or(step.rules)],
    ["after", "dependsOn", or(step.dependsOn)],
  ];
  return (
    <>
      <h4>
        {n} · {step.intent} <span className="dim">in {step.path}</span>
      </h4>
      <div className="dim">
        {step.worker ? `${step.worker.name}${step.worker.paneId ? ` · ${step.worker.paneId}` : ""} · ` : ""}
        {step.state}
        {step.evidence ? ` · ${step.evidence}` : ""}
      </div>
      <dl className="facts">
        {facts.map(([name, field, value]) => (
          <div className="row" key={name}>
            <dt className="dim">{name}</dt>
            <dd className="mono">
              {value}
              <FieldProblems problems={problemsAt(problems, step.id, field)} />
            </dd>
          </div>
        ))}
      </dl>
      <ProblemList
        problems={problemsAt(problems, step.id).filter(
          (p) => !facts.some(([, field]) => p.field?.endsWith(field)),
        )}
      />
      {step.worker?.paneId ? (
        <div className="actions">
          <Button variant="primary" onClick={() => onOpenPane(step.worker?.paneId as string, of.runId)}>
            Show the pane
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Next(of: Of) {
  const next = useBoard(of, (b) => b?.next ?? []);
  const done = useBoard(of, (b) => b?.status === "done");
  return (
    <div className="text">
      {next.length > 0
        ? next.map((n) => `${n.id}${n.owners.length > 0 ? ` (${n.owners.join(", ")})` : ""}`).join(" · ")
        : done
          ? "nothing: the run is done"
          : "this is the last stage"}
    </div>
  );
}

function Gates(of: Of) {
  const gates = useBoard(of, (b) => b?.gates ?? []);
  return gates.length > 0 ? (
    <div className="text">
      gates:{" "}
      {gates.map((g) => (
        <span key={`${g.gate}-${g.at}`} className={g.passed ? "green" : "red"}>
          {g.gate} {g.passed ? "✓" : "✕"}{" "}
        </span>
      ))}
    </div>
  ) : null;
}

function Resumes(of: Of) {
  const resumes = useBoard(of, (b) => b?.resumes ?? []);
  return resumes.length > 0 ? (
    <>
      <ListSection>resumed</ListSection>
      <ul className="text resumes" aria-label="resumes">
        {resumes.map((r) => (
          <li key={r.at}>
            <span className="dim mono">{clock(r.at)}</span> at {r.to}
            {r.to === r.from ? "" : ` (escalated at ${r.from})`} by {r.by}
            {r.note ? <span className="amber">: {r.note}</span> : null}
          </li>
        ))}
      </ul>
    </>
  ) : null;
}

function Workers({ onOpenPane, ...of }: Of & { onOpenPane: OpenPane }) {
  const workers = useBoard(of, (b) => b?.workers ?? []);
  return workers.length > 0 ? (
    <div>
      <ListSection>workers</ListSection>
      <div className="text">
        {workers.map((w) => (
          <div key={w.name}>
            <Button variant="ghost" className="mono" onClick={() => onOpenPane(w.paneId, of.runId)}>
              {w.name}
            </Button>{" "}
            <span className="dim">
              {w.stage} · {w.paneId} ·{" "}
              {w.result ? `${w.result.status}: ${w.result.summary}` : (w.state ?? "")}
            </span>
          </div>
        ))}
      </div>
    </div>
  ) : null;
}

function LastEvents(of: Of) {
  const entries = useBoard(of, (b) => b?.timeline.slice(-8) ?? []);
  return <ActivityList entries={entries} variant="list" />;
}

const stageTitle = (s: PlanBoardView["stages"][number]): string =>
  [
    s.owners.length > 0 ? `owner: ${s.owners.join(", ")}` : "",
    s.workedBy.length > 0 ? `worked by ${s.workedBy.join(", ")}` : "",
    s.startedAt ? `from ${clock(s.startedAt)}` : "",
    s.endedAt ? `to ${clock(s.endedAt)}` : "",
    s.verdict ? s.verdict : "",
  ]
    .filter((x) => x !== "")
    .join(" · ");
