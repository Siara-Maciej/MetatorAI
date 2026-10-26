import type { MetatorError } from "../domain/errors.ts";
import { outputTail } from "../domain/gate.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { PackageManager, ProcessRunner } from "../ports/index.ts";

export interface FlakyReport {
  readonly test: string;
  readonly runs: number;
  readonly passed: number;
  readonly failed: number;
  /** Some runs passed and some failed: the test does not decide the same way twice. */
  readonly flaky: boolean;
  /** Output of the first failing run. */
  readonly firstFailure?: string;
}

/** `flaky check <test> --runs N` (ADR-0041): the test runs N times through the repo's test script. */
export class CheckFlaky {
  constructor(
    private readonly packageManager: PackageManager,
    private readonly runner: ProcessRunner,
  ) {}

  async execute(input: {
    readonly test: string;
    readonly runs: number;
    readonly script: string;
  }): Promise<Result<FlakyReport, MetatorError>> {
    const command = await this.packageManager.scriptCommand(input.script, [input.test]);
    if (command.isErr()) return err(command.error);
    let passed = 0;
    let firstFailure: string | undefined;
    for (let i = 0; i < input.runs; i++) {
      const r = await this.runner.run(command.value, { timeoutMs: 600_000 });
      if (r.exitCode === 0) passed++;
      else firstFailure ??= outputTail(`${r.stdout}\n${r.stderr}`);
    }
    const failed = input.runs - passed;
    return ok({
      test: input.test,
      runs: input.runs,
      passed,
      failed,
      flaky: passed > 0 && failed > 0,
      ...(firstFailure ? { firstFailure } : {}),
    });
  }
}
