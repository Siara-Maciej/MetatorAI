import type { StageProgress } from "../api.ts";
import { lookOf } from "../model.ts";

/**
 * The stages of a run in one line, everywhere they are shown: `intake ✓ ─ plan ✓ ─ [build ⟳] ─
 * gates ·` under a run's header, the same with dots on the workbench's strip and on the plan.
 * With `onOpen` the line is a button (the workbench: it opens the plan).
 */
export function StageBar<S extends Pick<StageProgress, "id" | "state">>({
  stages,
  variant = "bar",
  titleOf,
  onOpen,
  testId,
}: {
  readonly stages: readonly S[];
  /** `bar`: wraps, ` ─ ` between, the current stage in brackets. `strip`: one line, ` · ` between. */
  readonly variant?: "bar" | "strip";
  /** What a stage says on hover (the plan: who worked on it, and when). */
  titleOf?: ((stage: S) => string) | undefined;
  onOpen?: (() => void) | undefined;
  readonly testId?: string | undefined;
}) {
  const separator = variant === "bar" ? " ─ " : " · ";
  const items = stages.map((s, i) => {
    const look = lookOf("stage", s.state);
    const text = `${s.id} ${look.glyph}`;
    return (
      <span key={s.id} title={titleOf?.(s)}>
        {i > 0 ? <span className="faint">{separator}</span> : null}
        <span className={look.tone} data-state={s.state}>
          {variant === "bar" && s.state === "current" ? `[${text}]` : text}
        </span>
      </span>
    );
  });
  return onOpen ? (
    <button
      type="button"
      className={`stagebar ${variant}`}
      title="the plan of this run"
      data-testid={testId}
      onClick={onOpen}
    >
      {items}
    </button>
  ) : (
    <span className={`stagebar ${variant}`} role="group" aria-label="stages" data-testid={testId}>
      {items}
    </span>
  );
}
