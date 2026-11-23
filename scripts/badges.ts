/**
 * The README's live badges from CI's results, as shields.io endpoint JSON
 * (https://shields.io/badges/endpoint-badge: `{ schemaVersion: 1, label, message, color }`, where
 * `schemaVersion` is shields' own field). CI (`.github/workflows/ci.yml`, on a push to main) writes
 * them; the docs workflow (`pages.yml`) publishes them under `badges/` of the Pages site.
 *
 * Usage:
 *   bun scripts/badges.ts --out <dir> [--lcov <lcov.info>]
 *     [--unit <log>] [--unit-outcome <o>] [--e2e <log>] [--e2e-outcome <o>]
 *     [--mutation <log>] [--mutation-outcome <o>]
 *   bun scripts/badges.ts --publish <dir> --out <dir>
 *
 * The first form reads the unit run's LCOV report, the test runs' output and the mutation smoke's
 * output (`<o>` is the step's outcome in Actions: success, failure, cancelled or skipped). A missing
 * input is a badge that says so, never an error: a failed job still gets badges that show it.
 * `--publish` copies the badges of `<dir>` (CI's artifact, possibly absent) to `--out`, each checked
 * against the endpoint schema; a missing or malformed one is published as "pending".
 *
 * Everything below `main` is pure and tested in e2e/badges.e2e.test.ts. Files are written only to
 * the `--out` directory.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** A shields.io endpoint badge. */
export interface Badge {
  readonly schemaVersion: 1;
  readonly label: string;
  readonly message: string;
  readonly color: string;
}

export type BadgeName = "coverage" | "tests" | "mutation";
export const BADGES: readonly BadgeName[] = ["coverage", "tests", "mutation"];
export const LABELS: Readonly<Record<BadgeName, string>> = {
  coverage: "coverage",
  tests: "tests",
  mutation: "mutants killed",
};

/** A step's outcome in GitHub Actions (`steps.<id>.outcome`); absent when not known. */
export type Outcome = "success" | "failure" | "cancelled" | "skipped";
const OUTCOMES: readonly string[] = ["success", "failure", "cancelled", "skipped"];

export function outcome(value: string | undefined): Outcome | undefined {
  return value !== undefined && OUTCOMES.includes(value) ? (value as Outcome) : undefined;
}

const badge = (label: string, message: string, color: string): Badge => ({
  schemaVersion: 1,
  label,
  message,
  color,
});

export const pendingBadge = (name: BadgeName): Badge => badge(LABELS[name], "pending", "lightgrey");

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are what this removes.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const lines = (text: string) => text.replace(ANSI, "").split(/\r?\n/);

// ---------------------------------------------------------------------------------------------
// Coverage

export interface LineTotal {
  readonly hit: number;
  readonly found: number;
}

/** Test files are not the code under test (bun leaves them out already; other tools may not). */
export const isSourceFile = (path: string): boolean =>
  !/(^|\/)(test|tests|__tests__)\//.test(path) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

/**
 * Total line coverage of an LCOV report: the sum of every record's `LH` (lines hit) and `LF`
 * (lines found), over the records whose `SF` passes `include`. Undefined when no record counts.
 */
export function lcovTotal(
  text: string,
  include: (path: string) => boolean = isSourceFile,
): LineTotal | undefined {
  let hit = 0;
  let found = 0;
  let records = 0;
  let file: string | undefined;
  let lh = 0;
  let lf = 0;
  for (const line of lines(text)) {
    const [key, ...rest] = line.trim().split(":");
    const value = rest.join(":");
    if (key === "SF") {
      file = value;
      lh = 0;
      lf = 0;
    } else if (key === "LH") lh = Number(value);
    else if (key === "LF") lf = Number(value);
    else if (line.trim() === "end_of_record" && file !== undefined) {
      if (include(file) && Number.isFinite(lh) && Number.isFinite(lf)) {
        hit += lh;
        found += lf;
        records++;
      }
      file = undefined;
    }
  }
  return records > 0 && found > 0 ? { hit, found } : undefined;
}

/** Shields' usual steps: 90 brightgreen, 80 green, 70 yellowgreen, 60 yellow, 50 orange, else red. */
export function coverageColor(percent: number): string {
  if (percent >= 90) return "brightgreen";
  if (percent >= 80) return "green";
  if (percent >= 70) return "yellowgreen";
  if (percent >= 60) return "yellow";
  if (percent >= 50) return "orange";
  return "red";
}

/** The percent is rounded down, so the badge never claims a step the code has not reached. */
export function coverageBadge(total: LineTotal | undefined): Badge {
  if (total === undefined) return badge(LABELS.coverage, "unknown", "lightgrey");
  const percent = (100 * total.hit) / total.found;
  return badge(LABELS.coverage, `${Math.floor(percent)}%`, coverageColor(percent));
}

// ---------------------------------------------------------------------------------------------
// Tests

export interface TestSummary {
  readonly pass: number;
  readonly fail: number;
}

/**
 * The summary `bun test` prints last (` 2584 pass`, ` 0 fail`, ` 1 error`): an error outside a
 * test counts as a failure. Undefined when the output has no summary (the run never finished).
 */
export function bunSummary(output: string): TestSummary | undefined {
  let pass: number | undefined;
  let fail = 0;
  for (const line of lines(output)) {
    const m = /^\s*(\d+) (pass|fail|errors?)\s*$/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (m[2] === "pass") {
      pass = n; // a later summary replaces an earlier one
      fail = 0;
    } else fail += n;
  }
  return pass === undefined ? undefined : { pass, fail };
}

export type Suite =
  | { readonly state: "passed"; readonly pass: number }
  | { readonly state: "failed"; readonly pass: number; readonly fail: number }
  | { readonly state: "failed-without-summary" }
  | { readonly state: "not-run" };

/**
 * One suite's result from its summary and its step's outcome. A failed step is a failure even
 * when its output says nothing failed, so a badge never shows green for a red step.
 */
export function suite(summary: TestSummary | undefined, stepOutcome: Outcome | undefined): Suite {
  if (summary === undefined)
    return stepOutcome === "failure" ? { state: "failed-without-summary" } : { state: "not-run" };
  if (summary.fail > 0 || stepOutcome === "failure")
    return { state: "failed", pass: summary.pass, fail: summary.fail };
  return { state: "passed", pass: summary.pass };
}

/**
 * `2584 unit · 576 e2e passing`, green only when both suites ran and nothing failed; red when
 * anything failed (`2580 unit · 576 e2e passing · 4 failing`); grey when a suite did not run.
 */
export function testsBadge(suites: Readonly<Record<"unit" | "e2e", Suite>>): Badge {
  const all = Object.entries(suites) as ["unit" | "e2e", Suite][];
  const counted = all.flatMap(([name, s]) => ("pass" in s ? [`${s.pass} ${name}`] : []));
  const failing = all.reduce((n, [, s]) => n + (s.state === "failed" ? s.fail : 0), 0);
  const parts = counted.length > 0 ? [`${counted.join(" · ")} passing`] : [];
  if (failing > 0) parts.push(`${failing} failing`);
  for (const [name, s] of all) {
    if (s.state === "failed-without-summary" || (s.state === "failed" && s.fail === 0))
      parts.push(`${name} failed`);
    if (s.state === "not-run") parts.push(`${name} not run`);
  }
  const failed = all.some(([, s]) => s.state === "failed" || s.state === "failed-without-summary");
  const passed = all.every(([, s]) => s.state === "passed");
  return badge(LABELS.tests, parts.join(" · "), failed ? "red" : passed ? "brightgreen" : "lightgrey");
}

// ---------------------------------------------------------------------------------------------
// Mutation smoke

export interface MutationTotals {
  readonly killed: number;
  readonly survived: number;
  readonly stale: number;
  /** Mutants the run selected; undefined when the run printed no total (it never finished). */
  readonly total: number | undefined;
}

/** The last line of scripts/mutation-smoke.ts, which `mutationTotals` reads back. */
export const mutationTotalLine = (t: {
  killed: number;
  survived: number;
  stale: number;
  total: number;
}): string => `TOTAL    ${t.killed} killed, ${t.survived} survived, ${t.stale} stale of ${t.total} mutants`;

/** The smoke's total line, else what its KILLED, SURVIVED and STALE lines add up to. */
export function mutationTotals(output: string): MutationTotals | undefined {
  let killed = 0;
  let survived = 0;
  let stale = 0;
  let seen = false;
  for (const line of lines(output)) {
    const total = /^TOTAL\s+(\d+) killed, (\d+) survived, (\d+) stale of (\d+) mutants\s*$/.exec(line);
    if (total)
      return {
        killed: Number(total[1]),
        survived: Number(total[2]),
        stale: Number(total[3]),
        total: Number(total[4]),
      };
    if (/^KILLED\s/.test(line)) killed++;
    else if (/^SURVIVED\s/.test(line)) survived++;
    else if (/^STALE\s/.test(line)) stale++;
    else continue;
    seen = true;
  }
  return seen ? { killed, survived, stale, total: undefined } : undefined;
}

/** `1593/1593`, green only when the run finished and killed every mutant it selected. */
export function mutationBadge(totals: MutationTotals | undefined, stepOutcome: Outcome | undefined): Badge {
  if (totals === undefined)
    return stepOutcome === "failure"
      ? badge(LABELS.mutation, "failed", "red")
      : badge(LABELS.mutation, "not run", "lightgrey");
  const total = totals.total ?? totals.killed + totals.survived + totals.stale;
  const all =
    totals.total !== undefined &&
    total > 0 &&
    totals.killed === total &&
    totals.survived === 0 &&
    totals.stale === 0 &&
    stepOutcome !== "failure";
  return badge(LABELS.mutation, `${totals.killed}/${total}`, all ? "brightgreen" : "red");
}

// ---------------------------------------------------------------------------------------------
// Publishing

const COLOR = /^([a-z]+|#?[0-9a-fA-F]{3}|#?[0-9a-fA-F]{6})$/;

/**
 * The badge to publish under `name`: CI's JSON when it is a well-formed endpoint badge with the
 * badge's own label, else "pending". Only the four fields are kept.
 */
export function publishable(name: BadgeName, text: string | undefined): Badge {
  if (text === undefined) return pendingBadge(name);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return pendingBadge(name);
  }
  if (typeof value !== "object" || value === null) return pendingBadge(name);
  const { schemaVersion, label, message, color } = value as Record<string, unknown>;
  const fits = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 100;
  if (schemaVersion !== 1 || label !== LABELS[name] || !fits(message) || !fits(color) || !COLOR.test(color))
    return pendingBadge(name);
  return badge(label, message, color);
}

export const badgeJson = (b: Badge): string => `${JSON.stringify(b, null, 2)}\n`;

// ---------------------------------------------------------------------------------------------
// The command

const readIfAny = (path: string | undefined): string | undefined =>
  path !== undefined && existsSync(path) ? readFileSync(path, "utf8") : undefined;

/** The three badges from CI's outputs; a missing file reads as a run that left nothing. */
export function badgesFrom(input: {
  lcov?: string | undefined;
  unit?: string | undefined;
  unitOutcome?: Outcome | undefined;
  e2e?: string | undefined;
  e2eOutcome?: Outcome | undefined;
  mutation?: string | undefined;
  mutationOutcome?: Outcome | undefined;
}): Record<BadgeName, Badge> {
  const summary = (log: string | undefined) => (log === undefined ? undefined : bunSummary(log));
  return {
    coverage: coverageBadge(input.lcov === undefined ? undefined : lcovTotal(input.lcov)),
    tests: testsBadge({
      unit: suite(summary(input.unit), input.unitOutcome),
      e2e: suite(summary(input.e2e), input.e2eOutcome),
    }),
    mutation: mutationBadge(
      input.mutation === undefined ? undefined : mutationTotals(input.mutation),
      input.mutationOutcome,
    ),
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      publish: { type: "string" },
      lcov: { type: "string" },
      unit: { type: "string" },
      "unit-outcome": { type: "string" },
      e2e: { type: "string" },
      "e2e-outcome": { type: "string" },
      mutation: { type: "string" },
      "mutation-outcome": { type: "string" },
    },
    strict: true,
  });
  if (values.out === undefined) {
    console.error("badges: --out <dir> is required");
    return 2;
  }
  const from = values.publish;
  const badges: Record<BadgeName, Badge> =
    from !== undefined
      ? {
          coverage: publishable("coverage", readIfAny(join(from, "coverage.json"))),
          tests: publishable("tests", readIfAny(join(from, "tests.json"))),
          mutation: publishable("mutation", readIfAny(join(from, "mutation.json"))),
        }
      : badgesFrom({
          lcov: readIfAny(values.lcov),
          unit: readIfAny(values.unit),
          unitOutcome: outcome(values["unit-outcome"]),
          e2e: readIfAny(values.e2e),
          e2eOutcome: outcome(values["e2e-outcome"]),
          mutation: readIfAny(values.mutation),
          mutationOutcome: outcome(values["mutation-outcome"]),
        });
  await mkdir(values.out, { recursive: true });
  for (const name of BADGES) {
    await Bun.write(join(values.out, `${name}.json`), badgeJson(badges[name]));
    console.log(`${name}: ${badges[name].label} · ${badges[name].message} (${badges[name].color})`);
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
