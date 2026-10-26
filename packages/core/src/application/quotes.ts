import { MetatorError } from "../domain/errors.ts";
import { locateQuote, type QuoteMatch } from "../domain/memory.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { ReadonlyFileSystem } from "../ports/index.ts";

/**
 * `findings check-quote` (ADR-0044): one quote against one file, with the matcher findings and
 * memory citations use (normalized whitespace, ±10 lines, a unique match anywhere).
 */
export class CheckQuote {
  constructor(private readonly fs: ReadonlyFileSystem) {}

  async execute(input: {
    readonly file: string;
    readonly line: number;
    readonly quote: string;
  }): Promise<Result<QuoteMatch & { readonly file: string }, MetatorError>> {
    const code = await this.fs.read(input.file);
    if (code.isErr()) return err(new MetatorError("NOT_FOUND", `${input.file} does not exist`));
    return ok({ file: input.file, ...locateQuote(code.value, input.line, input.quote) });
  }
}
