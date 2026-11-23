import { type GateStep, type MetatorConfig, parseMetatorStep } from "../domain/config.ts";
import type { MetatorError } from "../domain/errors.ts";
import { type GateReport, GateReportDocument, type GateStepResult, outputTail } from "../domain/gate.ts";
import { matchesAny } from "../domain/glob.ts";
import type { JavaBuild } from "../domain/java-build.ts";
import { buildProgram, isWindows, moduleOf, narrowToModules, wrapperOf } from "../domain/jvm-build.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type {
  BinResolver,
  Clock,
  FileSystem,
  JavaBuildReader,
  PackageManager,
  ProcessRunner,
  ResolvedCommand,
  Vcs,
} from "../ports/index.ts";
import { writeDocument } from "./document-io.ts";
import type { GateChecks } from "./gate-checks.ts";
import type { MetatorPaths } from "./paths.ts";

export type GateName = "quick" | "full";

/**
 * What to do about a gate with no steps. With a config the answer is the key to edit (`init`
 * refuses an existing config); without one, `init` proposes the gates.
 */
export function emptyGateHint(gate: GateName, source: string | undefined): string {
  return source
    ? `Add a step under \`gates.${gate}:\` in ${source}, e.g. \`- { id: test, run: { script: test } }\` (a package.json script; \`run: { metator: rules check }\` is a MetatorAI check).`
    : "Run `metator init`: it writes metator.config.yml with gates proposed from the repository's scripts.";
}

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
    private readonly checks: Pick<GateChecks, "run">,
    private readonly vcs: Vcs,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
    private readonly clock: Clock,
    /** The Java build (round 22): the modules a `files: modules` step narrows to. */
    private readonly java?: Pick<JavaBuildReader, "read">,
    /** The platform the gate runs on (`process.platform`): which wrapper file runs a build. */
    private readonly platform: () => string = () => "",
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
    const scope = { ...(existing ? { files: existing } : {}), ...(input.base ? { base: input.base } : {}) };
    const startedAt = this.clock.now().toISOString();

    const steps: GateStepResult[] = [];
    for (const step of this.config.gates[input.gate]) steps.push(await this.step(step, scope));
    const report: GateReport = {
      gate: input.gate,
      files: existing ? [...existing] : null,
      startedAt,
      passed: steps.every((s) => s.status === "pass" || s.status === "skipped"),
      steps,
    };
    const saved = await writeDocument(
      this.fs,
      `${this.paths.gates}/${input.gate}.json`,
      GateReportDocument,
      report,
      "json",
    );
    if (saved.isErr()) return err(saved.error);
    return ok(report);
  }

  private async step(
    step: GateStep,
    scope: { readonly files?: readonly string[]; readonly base?: string },
  ): Promise<GateStepResult> {
    const files = scope.files;
    const started = this.clock.now().getTime();
    const elapsed = () => Math.max(0, Math.round(this.clock.now().getTime() - started));
    if (files && files.length === 0)
      return { id: step.id, status: "skipped", durationMs: 0, detail: "no files to check" };

    if ("metator" in step.run) {
      const parsed = parseMetatorStep(step.run.metator);
      if (!parsed)
        return {
          id: step.id,
          status: "error",
          durationMs: 0,
          detail: `unknown MetatorAI step ${step.run.metator}`,
        };
      const r = await this.checks.run(parsed, scope);
      if (r.isErr()) return { id: step.id, status: "error", durationMs: elapsed(), detail: r.error.message };
      return {
        id: step.id,
        status: r.value.passed ? "pass" : "fail",
        durationMs: elapsed(),
        ...(r.value.detail ? { detail: r.value.detail } : {}),
      };
    }

    const matched = files && step.match ? files.filter((f) => matchesAny(f, step.match ?? [])) : files;
    if (step.files !== "none" && matched && matched.length === 0) {
      return { id: step.id, status: "skipped", durationMs: 0, detail: "no files this step checks" };
    }
    const args = step.files === "append" && matched ? matched : [];
    const command =
      "build" in step.run
        ? await this.build(step.run, step.files === "modules" && matched ? matched : undefined)
        : await this.command(step.run, args);
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
    run: Exclude<GateStep["run"], { metator: string } | { build: string }>,
    args: readonly string[],
  ): Promise<Result<ResolvedCommand, MetatorError>> {
    if ("script" in run) return this.packageManager.scriptCommand(run.script, args);
    if ("workspaces" in run) return this.packageManager.workspacesCommand(run.workspaces);
    return ok(await this.bins.command(run.bin, [...run.args, ...args]));
  }

  /**
   * A Maven or Gradle build: its wrapper at the root when there is one, else the tool from PATH.
   * With `files`, only their modules (`moduleOf`; a file of no module is the whole build's).
   */
  private async build(
    run: Extract<GateStep["run"], { build: string }>,
    files: readonly string[] | undefined,
  ): Promise<Result<ResolvedCommand, MetatorError>> {
    let args = [...run.args];
    if (files) {
      // The modules as the Java build reader reads them; unread, the whole build.
      const read = this.java ? await this.java.read() : undefined;
      const build: JavaBuild = read?.isOk() ? read.value : { tools: [], modules: [], notes: [] };
      const modules = new Set(files.map((file) => moduleOf(run.build, file, build)));
      args = narrowToModules(run.build, run.args, [...modules]);
    }
    // The wrapper that runs where the gate runs: `mvnw` here, `mvnw.cmd` on Windows.
    const platform = this.platform();
    const wrapper = wrapperOf(run.build, platform);
    const there = await this.fs.exists(wrapper);
    // The resolver says where the repository is; the wrapper is run from there, by its path.
    const at = await this.bins.command(buildProgram(run.build, false), args);
    const sep = isWindows(platform) ? "\\" : "/";
    const program = there
      ? `${at.cwd.replace(/[\\/]+$/, "")}${sep}${wrapper}`
      : buildProgram(run.build, false, platform);
    return ok({ ...at, argv: [program, ...args] });
  }

  /** Deleted files cannot be passed to tools. */
  private async existing(files: readonly string[]): Promise<readonly string[]> {
    const out: string[] = [];
    for (const f of files) if (await this.fs.exists(f)) out.push(f);
    return out;
  }
}
