/**
 * The run's implementation plan as fields: the task and the scope, then every step with its
 * action, file, intent, exemplar, rules, tests written first and the steps it waits for. A step
 * moves with ↑ ↓ (or Alt+↑ / Alt+↓ inside it) and goes with ✕; "+ Step" adds one at the end. The
 * lint's problems stand under the field they are about.
 */
import type { Plan, PlanLintProblem, PlanStep } from "../api.ts";
import { FieldProblems, ProblemList } from "../components/doc-editor.tsx";
import { problemsAt } from "../model.ts";
import { listOf, textOf, withoutStep, withStep, withStepChanged, withStepMoved } from "../plan-edit.ts";

export function PlanForm({
  plan,
  problems,
  onChange,
}: {
  readonly plan: Plan;
  readonly problems: readonly PlanLintProblem[];
  onChange(change: (p: Plan) => Plan): void;
}) {
  const general = problems.filter((p) => p.step === undefined && !(p.field ?? "").startsWith("steps."));
  const step = (id: string, patch: Parameters<typeof withStepChanged>[2]) =>
    onChange((p) => withStepChanged(p, id, patch));
  return (
    <div className="plan-form" data-testid="plan-form">
      <ProblemList problems={general} testId="plan-problems" />
      <label className="pf-field wide">
        <span>Task</span>
        <input
          aria-label="plan task"
          value={plan.task}
          onChange={(e) => onChange((p) => ({ ...p, task: e.target.value }))}
        />
        <FieldProblems problems={problemsAt(problems, undefined, "task")} />
      </label>
      <label className="pf-field wide">
        <span>Scope</span>
        <input
          aria-label="plan scope"
          className="mono"
          value={textOf(plan.scope)}
          placeholder="the directories the plan may touch, separated by commas"
          onChange={(e) => onChange((p) => ({ ...p, scope: listOf(e.target.value) }))}
        />
        <FieldProblems problems={problemsAt(problems, undefined, "scope")} />
      </label>
      <ol className="pf-steps">
        {plan.steps.map((s, i) => (
          <StepFields
            key={s.id}
            step={s}
            index={i}
            count={plan.steps.length}
            problems={problems.filter((p) => p.step === s.id || (p.field ?? "").startsWith(`steps.${i}.`))}
            onChange={(patch) => step(s.id, patch)}
            onMove={(dir) => onChange((p) => withStepMoved(p, s.id, dir))}
            onRemove={() => onChange((p) => withoutStep(p, s.id))}
          />
        ))}
      </ol>
      <button type="button" onClick={() => onChange((p) => withStep(p))}>
        + Step
      </button>
    </div>
  );
}

function StepFields({
  step: s,
  index,
  count,
  problems,
  onChange,
  onMove,
  onRemove,
}: {
  readonly step: PlanStep;
  readonly index: number;
  readonly count: number;
  readonly problems: readonly PlanLintProblem[];
  onChange(patch: Parameters<typeof withStepChanged>[2]): void;
  onMove(dir: -1 | 1): void;
  onRemove(): void;
}) {
  const at = (field: string) =>
    problems.filter((p) => p.field === field || (p.field ?? "").endsWith(`.${field}`));
  const loose = problems.filter((p) => p.field === undefined || !/\.(\w+)$/.test(p.field));
  return (
    <li
      className="pf-step"
      aria-label={`step ${s.id}`}
      data-testid={`plan-step-${s.id}`}
      onKeyDown={(e) => {
        if (!e.altKey) return;
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          onMove(e.key === "ArrowUp" ? -1 : 1);
        }
      }}
    >
      <div className="pf-head">
        <b className="mono">{s.id}</b>
        <span className="faint">
          step {index + 1} of {count}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="ghost"
          aria-label={`move ${s.id} up`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="ghost"
          aria-label={`move ${s.id} down`}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button type="button" className="ghost" aria-label={`remove ${s.id}`} onClick={onRemove}>
          ✕
        </button>
      </div>
      <ProblemList problems={loose} />
      <div className="pf-grid">
        <label className="pf-field">
          <span>Action</span>
          <select
            aria-label={`${s.id} action`}
            value={s.action}
            onChange={(e) => onChange({ action: e.target.value as PlanStep["action"] })}
          >
            <option value="create">create</option>
            <option value="modify">modify</option>
            <option value="delete">delete</option>
          </select>
        </label>
        <label className="pf-field">
          <span>File</span>
          <input
            aria-label={`${s.id} file`}
            className="mono"
            value={s.path}
            onChange={(e) => onChange({ path: e.target.value })}
          />
          <FieldProblems problems={at("path")} />
        </label>
        <label className="pf-field wide">
          <span>Intent</span>
          <input
            aria-label={`${s.id} intent`}
            value={s.intent}
            onChange={(e) => onChange({ intent: e.target.value })}
          />
          <FieldProblems problems={at("intent")} />
        </label>
        <label className="pf-field">
          <span>Exemplar</span>
          <input
            aria-label={`${s.id} exemplar`}
            className="mono"
            placeholder="file:line"
            value={s.patternSource?.exemplar ?? ""}
            onChange={(e) => onChange({ exemplar: e.target.value })}
          />
          <FieldProblems problems={at("exemplar")} />
        </label>
        <label className="pf-field">
          <span>Rules</span>
          <input
            aria-label={`${s.id} rules`}
            className="mono"
            value={textOf(s.rules)}
            onChange={(e) => onChange({ rules: listOf(e.target.value) })}
          />
          <FieldProblems problems={at("rules")} />
        </label>
        <label className="pf-field">
          <span>Tests first</span>
          <input
            aria-label={`${s.id} tests first`}
            className="mono"
            value={textOf(s.testsFirst)}
            onChange={(e) => onChange({ testsFirst: listOf(e.target.value) })}
          />
          <FieldProblems problems={at("testsFirst")} />
        </label>
        <label className="pf-field">
          <span>After</span>
          <input
            aria-label={`${s.id} after`}
            className="mono"
            placeholder="S1, S2"
            value={textOf(s.dependsOn)}
            onChange={(e) => onChange({ dependsOn: listOf(e.target.value) })}
          />
          <FieldProblems problems={at("dependsOn")} />
        </label>
      </div>
    </li>
  );
}

/** The document as JSON a person edits; the daemon checks it against the plan's schema. */
export function TextEditor({
  text,
  label,
  problems,
  onChange,
}: {
  readonly text: string;
  readonly label: string;
  readonly problems: readonly PlanLintProblem[];
  onChange(text: string): void;
}) {
  return (
    <div className="text-editor">
      <ProblemList problems={problems} testId="text-problems" />
      <textarea
        aria-label={label}
        className="mono"
        spellCheck={false}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
