import { type CoverageDiff, coverageDiff } from "../domain/coverage.ts";
import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { CoverageReader, RevisionReader } from "../ports/index.ts";

export const DEFAULT_LCOV = "coverage/lcov.info";
const CODE = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];

/** `coverage diff --base <ref> [--lcov <file>]`: coverage of the lines added since the base. */
export class DiffCoverage {
  constructor(
    private readonly history: Pick<RevisionReader, "addedLines">,
    private readonly coverage: CoverageReader,
    private readonly testGlobs: readonly string[],
  ) {}

  async execute(input: {
    readonly base: string;
    readonly lcov?: string;
  }): Promise<Result<CoverageDiff & { readonly base: string; readonly report: string }, MetatorError>> {
    const report = input.lcov ?? DEFAULT_LCOV;
    const added = await this.history.addedLines(input.base);
    if (added.isErr()) return err(added.error);
    const hits = await this.coverage.read(report);
    if (hits.isErr()) return err(hits.error);
    // Tests are not measured code: their lines run by definition.
    return ok({
      base: input.base,
      report,
      ...coverageDiff(added.value, hits.value, { code: CODE, ignore: this.testGlobs }),
    });
  }
}
