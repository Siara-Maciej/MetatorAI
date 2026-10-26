import { matchesAny } from "./glob.ts";

/**
 * `coverage diff` (ADR-0041): how many of the lines a change adds are covered by tests. Only
 * instrumented lines count (a comment or a type is neither covered nor uncovered); added code
 * files the report never measured are listed apart, since no test loaded them.
 */
export interface CoverageDiff {
  readonly instrumented: number;
  readonly covered: number;
  /** Covered share of the instrumented added lines; 100 when nothing instrumented was added. */
  readonly percent: number;
  readonly files: readonly {
    readonly file: string;
    readonly covered: number;
    readonly uncovered: readonly number[];
  }[];
  /** Code files with added lines that the coverage report does not mention. */
  readonly unmeasured: readonly string[];
}

export function coverageDiff(
  added: ReadonlyMap<string, readonly number[]>,
  coverage: ReadonlyMap<string, ReadonlyMap<number, number>>,
  options: { readonly code: readonly string[]; readonly ignore: readonly string[] },
): CoverageDiff {
  let instrumented = 0;
  let covered = 0;
  const files: { file: string; covered: number; uncovered: number[] }[] = [];
  const unmeasured: string[] = [];
  for (const [file, lines] of [...added].sort(([a], [b]) => a.localeCompare(b))) {
    if (!matchesAny(file, options.code) || matchesAny(file, options.ignore)) continue;
    const hits = coverage.get(file);
    if (!hits) {
      unmeasured.push(file);
      continue;
    }
    const measured = lines.filter((l) => hits.has(l));
    const uncovered = measured.filter((l) => (hits.get(l) ?? 0) === 0);
    instrumented += measured.length;
    covered += measured.length - uncovered.length;
    if (measured.length > 0) files.push({ file, covered: measured.length - uncovered.length, uncovered });
  }
  const percent = instrumented === 0 ? 100 : Math.floor((covered / instrumented) * 1000) / 10;
  return { instrumented, covered, percent, files, unmeasured };
}
