import { join } from "node:path";
import {
  type MetatorError,
  ok,
  type Result,
  rulesFromNxEslint,
  rulesFromTurbo,
  type ToolBoundaries,
  type ToolBoundariesReader,
} from "@metator/core";

/** Root-level files whose boundary rules `arch init` imports. */
const SOURCES = [
  { file: "turbo.json", rules: rulesFromTurbo },
  { file: ".eslintrc.json", rules: rulesFromNxEslint },
  { file: ".eslintrc", rules: rulesFromNxEslint },
] as const;

/**
 * Turborepo `boundaries` (turbo.json) and Nx `depConstraints` (ESLint JSON configs), parsed as
 * JSONC like the tools themselves do. A file that is missing, broken or has no rules adds none;
 * flat ESLint configs are code and are not read.
 */
export class JsonToolBoundariesReader implements ToolBoundariesReader {
  constructor(private readonly root: string) {}

  async read(): Promise<Result<readonly ToolBoundaries[], MetatorError>> {
    const found: ToolBoundaries[] = [];
    for (const source of SOURCES) {
      const file = Bun.file(join(this.root, source.file));
      if (!(await file.exists())) continue;
      let json: unknown;
      try {
        json = Bun.JSONC.parse(await file.text());
      } catch {
        continue;
      }
      const rules = source.rules(json);
      if (rules.length > 0) found.push({ source: source.file, rules });
    }
    return ok(found);
  }
}
