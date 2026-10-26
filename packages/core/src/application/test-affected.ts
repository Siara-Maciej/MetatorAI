import type { MetatorError } from "../domain/errors.ts";
import { outputTail } from "../domain/gate.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { PackageManager, ProcessRunner } from "../ports/index.ts";
import type { ComputeAffected, ComputeAffectedInput } from "./compute-affected.ts";

export interface AffectedTestRun {
  readonly changed: readonly string[];
  readonly tests: readonly string[];
  /** null when no test is affected and nothing ran. */
  readonly command: readonly string[] | null;
  readonly exitCode: number | null;
  readonly passed: boolean;
  readonly output?: string;
}

/**
 * `test affected` (ADR-0036): the tests the import graph says a change reaches, run through the
 * repository's own test script (so its runner and flags apply), with the files appended.
 */
export class RunAffectedTests {
  constructor(
    private readonly affected: Pick<ComputeAffected, "execute">,
    private readonly packageManager: PackageManager,
    private readonly runner: ProcessRunner,
  ) {}

  async execute(
    input: ComputeAffectedInput & { readonly script: string; readonly timeoutMs?: number },
  ): Promise<Result<AffectedTestRun, MetatorError>> {
    const set = await this.affected.execute(input);
    if (set.isErr()) return err(set.error);
    const { changed, tests } = set.value;
    if (tests.length === 0) return ok({ changed, tests, command: null, exitCode: null, passed: true });

    const command = await this.packageManager.scriptCommand(input.script, tests);
    if (command.isErr()) return err(command.error);
    const r = await this.runner.run(command.value, { timeoutMs: input.timeoutMs ?? 600_000 });
    return ok({
      changed,
      tests,
      command: [...command.value.argv],
      exitCode: r.exitCode,
      passed: r.exitCode === 0,
      output: outputTail(`${r.stdout}\n${r.stderr}`),
    });
  }
}
