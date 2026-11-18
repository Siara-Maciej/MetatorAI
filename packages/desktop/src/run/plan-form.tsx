/** A document edited as JSON text (the system map), with the problems of what was typed. */
import type { PlanLintProblem } from "../api.ts";
import { ProblemList } from "../components/doc-editor.tsx";

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
