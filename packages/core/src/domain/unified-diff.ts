/**
 * A unified diff of one file from its text before and after (F3 golden set): what `git apply`
 * takes to plant a seeded bug on a base commit. One hunk around the changed lines, with three
 * lines of context, in the `diff --git` form git itself writes.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (before === after) return "";
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - context);
  const toA = Math.min(a.length, endA + context);
  const toB = Math.min(b.length, endB + context);
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`,
    ...a.slice(from, start).map((l) => ` ${l}`),
    ...a.slice(start, endA).map((l) => `-${l}`),
    ...b.slice(start, endB).map((l) => `+${l}`),
    ...a.slice(endA, toA).map((l) => ` ${l}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** The first line (1-based) of `after` that differs from `before`; the last line when only lines were removed. */
export function firstChangedLine(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return Math.min(i + 1, Math.max(1, b.length));
}
