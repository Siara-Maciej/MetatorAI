import type { MetatorError } from "../domain/errors.ts";
import { CODEOWNERS_FILES, type Ownership, ownersOf, parseCodeowners } from "../domain/owners.ts";
import { ok, type Result } from "../domain/result.ts";
import type { ReadonlyFileSystem } from "../ports/index.ts";

export interface OwnersReport {
  /** The CODEOWNERS file read, or undefined when the repository has none. */
  readonly source?: string;
  readonly owners: readonly Ownership[];
}

/** `owners <paths…>` (ADR-0045): owners of each path from the repository's CODEOWNERS. */
export class FindOwners {
  constructor(private readonly fs: ReadonlyFileSystem) {}

  async execute(input: { readonly paths: readonly string[] }): Promise<Result<OwnersReport, MetatorError>> {
    for (const source of CODEOWNERS_FILES) {
      const text = await this.fs.read(source);
      if (text.isErr()) continue;
      const rules = parseCodeowners(text.value);
      return ok({ source, owners: input.paths.map((p) => ownersOf(p, rules)) });
    }
    return ok({ owners: input.paths.map((path) => ({ path, owners: [] })) });
  }
}
