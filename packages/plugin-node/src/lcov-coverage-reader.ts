import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import lcovParser from "@friedemannsommer/lcov-parser/sync";
import { type CoverageReader, err, MetatorError, normalizePath, ok, type Result } from "@metator/core";

/** Line coverage from an LCOV report (bun, vitest, jest, c8 all write one) via lcov-parser. */
export class LcovCoverageReader implements CoverageReader {
  constructor(private readonly root: string) {}

  async read(
    report: string,
  ): Promise<Result<ReadonlyMap<string, ReadonlyMap<number, number>>, MetatorError>> {
    const file = isAbsolute(report) ? report : join(this.root, report);
    if (!existsSync(file))
      return err(
        new MetatorError("NOT_FOUND", `coverage report ${report} not found`, {
          hint: "Run the tests with LCOV coverage first, e.g. `bun test --coverage --coverage-reporter=lcov`.",
        }),
      );
    let sections: ReturnType<typeof lcovParser>;
    try {
      sections = lcovParser({ from: readFileSync(file, "utf8") });
    } catch (e) {
      return err(new MetatorError("INVALID_ARTIFACT", `${report}: ${(e as Error).message}`));
    }
    const out = new Map<string, Map<number, number>>();
    for (const s of sections) {
      const path = normalizePath(isAbsolute(s.path) ? relative(this.root, s.path) : s.path);
      const lines = out.get(path) ?? new Map<number, number>();
      for (const d of s.lines.details) lines.set(d.line, (lines.get(d.line) ?? 0) + d.hit);
      out.set(path, lines);
    }
    return ok(out);
  }
}
