/**
 * What a task leaves open before a run starts (P3). Deterministic and cheap: each finding is
 * something the intake would otherwise come back to a person with, after the run started.
 */
export function taskWarnings(task: string): string[] {
  const text = task.trim();
  const out: string[] = [];
  const words = text.split(/\s+/).filter(Boolean).length;
  // A work item reference (#123, ABC-42, a URL) is the whole task by design.
  const reference = /^(#\d+|[A-Z][A-Z0-9]+-\d+|https?:\/\/\S+)$/.test(text);
  if (!reference && words < 4)
    out.push(
      `task: ${words} word(s): say what should change and how you will know it works, or the intake asks`,
    );
  const asked = text
    .split(/(?<=[.!?])\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith("?") && !s.endsWith("???") && !/^https?:/.test(s));
  if (asked.length > 0)
    out.push(
      `task: it asks ${asked.length === 1 ? "a question" : `${asked.length} questions`} (${asked[0]}): decide it in the task, or the run asks you back`,
    );
  const placeholder = /\b(TBD|TODO|FIXME)\b|\?\?\?/.exec(text);
  if (placeholder)
    out.push(`task: "${placeholder[0]}" leaves a part undecided: fill it in, or the run asks you back`);
  return out;
}
