import type { GateStep, MetatorConfig } from "../domain/config.ts";
import type { MetatorError } from "../domain/errors.ts";
import { type GateReport, GateReportDocument, type GateStepResult, outputTail } from "../domain/gate.ts";
import { matchesAny } from "../domain/glob.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { serializeJsonDocument } from "../domain/versioned.ts";
import type {
  BinResolver,
  Clock,
  FileSystem,
  PackageManager,
  ProcessRunner,
  ResolvedCommand,
  Vcs,
} from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";
import type { CheckRules } from "./rules.ts";

export type GateName = "quick" | "full";

/**
 * Runs a gate's steps from the config (ADR-0029): package.json scripts through the repo's
 * package manager, binaries from node_modules/.bin, MetatorAI checks in process. Every step
 * runs (no bail), so one report shows everything that is red.
 */
export class RunGate {
  constructor(
    private readonly config: MetatorConfig,
    private readonly packageManager: PackageManager,
    private readonly bins: BinResolver,
    private readonly runner: ProcessRunner,
    private readonly checkRules: Pick<CheckRules, "execute">,
    private readonly vcs: Vcs,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly gate: GateName;
    readonly files?: readonly string[];
    readonly base?: string;
  }): Promise<Result<GateReport, MetatorError>> {
    let files = input.files;
    if (!files && input.base) {
      const changed = await this.vcs.changedFiles(input.base);
      if (changed.isErr()) return err(changed.error);
      files = changed.value;
    }
    const existing = files ? await this.existing(files) : undefined;
    const startedAt = this.clock.now().toISOString();

    const steps: GateStepResult[] = [];
    for (const step of this.config.gates[input.gate]) steps.push(await this.step(step, existing));
    const report: GateReport = {
      gate: input.gate,
      files: existing ? [...existing] : null,
      startedAt,
      passed: steps.every((s) => s.status === "pass" || s.status === "skipped"),
      steps,
    };
    const saved = await this.fs.write(
      `${this.paths.gates}/${input.gate}.json`,
      serializeJsonDocument(GateReportDocument.stamp(report)),
    );
    if (saved.isErr()) return err(saved.error);
    return ok(report);
  }

  private async step(step: GateStep, files: readonly string[] | undefined): Promise<GateStepResult> {
    const started = this.clock.now().getTime();
    const elapsed = () => Math.max(0, Math.round(this.clock.now().getTime() - started));
    if (files && files.length === 0)
      return { id: step.id, status: "skipped", durationMs: 0, detail: "no files to check" };

    if ("metator" in step.run) {
      const report = await this.checkRules.execute(files ? { files } : {});
      if (report.isErr())
        return { id: step.id, status: "error", durationMs: elapsed(), detail: report.error.message };
      const errors = report.value.violations.filter((v) => v.severity === "error");
      return errors.length === 0
        ? { id: step.id, status: "pass", durationMs: elapsed() }
        : {
            id: step.id,
            status: "fail",
            durationMs: elapsed(),
            detail: errors
              .slice(0, 20)
              .map(
                (v) => `${v.file}:${v.line ?? 1} ${v.canonRuleId ?? v.toolRuleId ?? v.engine}: ${v.message}`,
              )
              .join("\n"),
          };
    }

    const matched = files && step.match ? files.filter((f) => matchesAny(f, step.match ?? [])) : files;
    if (step.files === "append" && matched && matched.length === 0) {
      return { id: step.id, status: "skipped", durationMs: 0, detail: "no files this step checks" };
    }
    const args = step.files === "append" && matched ? matched : [];
    const command = await this.command(step.run, args);
    if (command.isErr())
      return { id: step.id, status: "error", durationMs: elapsed(), detail: command.error.message };
    const r = await this.runner.run(command.value, { timeoutMs: step.timeoutMs });
    const base = {
      id: step.id,
      command: [...command.value.argv],
      exitCode: r.exitCode,
      durationMs: elapsed(),
    };
    if (step.okExitCodes.includes(r.exitCode)) return { ...base, status: "pass" };
    const missing = r.exitCode === 127;
    return {
      ...base,
      status: missing ? "error" : "fail",
      detail: missing ? `not found: ${command.value.argv[0]}` : outputTail(`${r.stdout}\n${r.stderr}`),
    };
  }

  private async command(
    run: Exclude<GateStep["run"], { metator: string }>,
    args: readonly string[],
  ): Promise<Result<ResolvedCommand, MetatorError>> {
    if ("script" in run) return this.packageManager.scriptCommand(run.script, args);
    return ok(await this.bins.command(run.bin, [...run.args, ...args]));
  }

  /** Deleted files cannot be passed to tools. */
  private async existing(files: readonly string[]): Promise<readonly string[]> {
    const out: string[] = [];
    for (const f of files) if (await this.fs.exists(f)) out.push(f);
    return out;
  }
}
