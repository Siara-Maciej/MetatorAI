import { parse } from "shell-quote";
import { MetatorError } from "../domain/errors.ts";
import {
  type CaseScore,
  type EvalCase,
  EvalCaseDocument,
  EvalReportDocument,
  type EvalTotals,
  regressions,
  scoreCase,
  totals,
} from "../domain/eval.ts";
import { FindingSetDocument } from "../domain/finding.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { VerdictDocument } from "../domain/verdict.ts";
import { parseJsonDocument, parseYamlDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { BinResolver, FileSystem, ProcessRunner } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";

/** The golden set: every `EvalCase` YAML under `paths.evals`. */
export class EvalCatalog {
  constructor(
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async scan(): Promise<Result<readonly EvalCase[], MetatorError>> {
    const cases: EvalCase[] = [];
    const problems: string[] = [];
    for (const source of [
      ...(await this.fs.glob([`${this.paths.evals}/*.yml`, `${this.paths.evals}/*.yaml`])),
    ].sort()) {
      const parsed = (await this.fs.read(source))
        .andThen((t) => parseYamlDocument(t, source))
        .andThen((raw) => EvalCaseDocument.parse(raw, source));
      if (parsed.isOk()) cases.push(parsed.value);
      else problems.push(parsed.error.message);
    }
    if (problems.length > 0) {
      return err(
        new MetatorError("INVALID_CONFIG", `${problems.length} invalid eval case(s)`, {
          details: { problems },
        }),
      );
    }
    return ok(cases);
  }
}

export interface ScoreReport {
  readonly cases: number;
  readonly runs: number;
  readonly totals: EvalTotals;
  readonly scores: readonly CaseScore[];
  /** `<case>/<run>` outputs that do not exist or have no merged findings. */
  readonly missing: readonly string[];
  readonly output: string;
}

/**
 * `eval score <runs-dir>`: reads `<runs-dir>/<case>/<run>/findings/merged.json` and `verdict.json`
 * for every case of the golden set, and writes a versioned EvalReport to `<runs-dir>/report.json`.
 */
export class ScoreEvals {
  constructor(
    private readonly catalog: EvalCatalog,
    private readonly fs: FileSystem,
  ) {}

  async execute(input: { readonly runsDir: string }): Promise<Result<ScoreReport, MetatorError>> {
    const cases = await this.catalog.scan();
    if (cases.isErr()) return err(cases.error);
    if (cases.value.length === 0) {
      return err(
        new MetatorError("NOT_FOUND", "The golden set is empty", {
          hint: "Add EvalCase files to docs/metator/evals/golden/.",
        }),
      );
    }
    const dir = input.runsDir.replace(/\/$/, "");
    const scores: CaseScore[] = [];
    const missing: string[] = [];
    let runs = 0;
    for (const c of cases.value) {
      const runDirs = [
        ...new Set(
          (await this.fs.glob([`${dir}/${c.id}/*/**`])).map(
            (f) => f.slice(`${dir}/${c.id}/`.length).split("/")[0] as string,
          ),
        ),
      ].sort();
      if (runDirs.length === 0) missing.push(`${c.id}/*`);
      for (const run of runDirs) {
        const findings = await this.json(`${dir}/${c.id}/${run}/findings/merged.json`, (raw, s) =>
          FindingSetDocument.parse(raw, s),
        );
        if (!findings) {
          missing.push(`${c.id}/${run}`);
          continue;
        }
        const verdict = await this.json(`${dir}/${c.id}/${run}/verdict.json`, (raw, s) =>
          VerdictDocument.parse(raw, s),
        );
        runs++;
        scores.push(scoreCase(c, findings.findings, Number(run) || runs, verdict?.decision ?? "none"));
      }
    }
    const report = { cases: cases.value.length, runs, totals: totals(scores), scores, missing };
    const output = `${dir}/report.json`;
    const saved = await this.fs.write(output, serializeJsonDocument(EvalReportDocument.stamp(report)));
    if (saved.isErr()) return err(saved.error);
    return ok({ ...report, output });
  }

  private async json<T>(
    path: string,
    parseDoc: (raw: unknown, source: string) => Result<T, MetatorError>,
  ): Promise<T | undefined> {
    const parsed = (await this.fs.read(path))
      .andThen((t) => parseJsonDocument(t, path))
      .andThen((raw) => parseDoc(raw, path));
    return parsed.isOk() ? parsed.value : undefined;
  }
}

/** `eval compare <before> <after>`: regressions between two EvalReports (agent changes gate). */
export class CompareEvals {
  constructor(private readonly fs: FileSystem) {}

  async execute(input: {
    readonly before: string;
    readonly after: string;
    readonly tolerance: number;
  }): Promise<
    Result<
      { readonly before: EvalTotals; readonly after: EvalTotals; readonly regressions: readonly string[] },
      MetatorError
    >
  > {
    const read = async (path: string) =>
      (await this.fs.read(path))
        .andThen((t) => parseJsonDocument(t, path))
        .andThen((raw) => EvalReportDocument.parse(raw, path));
    const before = await read(input.before);
    if (before.isErr()) return err(before.error);
    const after = await read(input.after);
    if (after.isErr()) return err(after.error);
    return ok({
      before: before.value.totals,
      after: after.value.totals,
      regressions: regressions(before.value.totals, after.value.totals, input.tolerance),
    });
  }
}

/**
 * `eval run --command <template>`: runs the host's headless review once per case and repeat.
 * Placeholders {case} {base} {head} {out} {run} are filled in; the template is split like a
 * shell would split it, but never run through a shell.
 */
export class RunEvals {
  constructor(
    private readonly catalog: EvalCatalog,
    private readonly bins: BinResolver,
    private readonly runner: ProcessRunner,
  ) {}

  async execute(input: {
    readonly command: string;
    readonly runsDir: string;
    readonly repeat: number;
    readonly timeoutMs: number;
  }): Promise<
    Result<
      { readonly runs: readonly { case: string; run: number; exitCode: number; durationMs: number }[] },
      MetatorError
    >
  > {
    const cases = await this.catalog.scan();
    if (cases.isErr()) return err(cases.error);
    const runs: { case: string; run: number; exitCode: number; durationMs: number }[] = [];
    for (const c of cases.value) {
      for (let run = 1; run <= input.repeat; run++) {
        const out = `${input.runsDir.replace(/\/$/, "")}/${c.id}/${run}`;
        const values: Record<string, string> = {
          case: c.id,
          base: c.base,
          head: c.head,
          out,
          run: String(run),
        };
        const argv = parse(input.command).map((t) =>
          typeof t === "string"
            ? t.replace(/\{(case|base|head|out|run)\}/g, (_, k: string) => values[k] as string)
            : "",
        );
        if (argv.length === 0 || argv.some((a) => a === "")) {
          return err(
            MetatorError.usage(
              "The eval command must be a plain command, without shell operators",
              "Wrap pipes or redirects in a script.",
            ),
          );
        }
        const command = await this.bins.command(argv[0] as string, argv.slice(1));
        const r = await this.runner.run(
          {
            ...command,
            env: {
              METATOR_EVAL_CASE: c.id,
              METATOR_EVAL_BASE: c.base,
              METATOR_EVAL_HEAD: c.head,
              METATOR_EVAL_OUT: out,
            },
          },
          { timeoutMs: input.timeoutMs },
        );
        runs.push({ case: c.id, run, exitCode: r.exitCode, durationMs: Math.round(r.durationMs) });
      }
    }
    return ok({ runs });
  }
}
