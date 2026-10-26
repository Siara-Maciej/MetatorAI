import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Diagnostic,
  type EngineRule,
  err,
  MetatorError,
  normalizePath,
  ok,
  type ProcessRunner,
  type Result,
  type RuleEngine,
} from "@metator/core";

/** Options `strict` turns on unless they are set to false explicitly. */
const STRICT_FAMILY = [
  "alwaysStrict",
  "noImplicitAny",
  "noImplicitThis",
  "strictBindCallApply",
  "strictBuiltinIteratorReturn",
  "strictFunctionTypes",
  "strictNullChecks",
  "strictPropertyInitialization",
  "useUnknownInCatchVariables",
];

/** Boolean compiler options that are checks (a canon rule can bind to them). */
const CHECKS = [
  "strict",
  ...STRICT_FAMILY,
  "erasableSyntaxOnly",
  "exactOptionalPropertyTypes",
  "forceConsistentCasingInFileNames",
  "isolatedModules",
  "noFallthroughCasesInSwitch",
  "noImplicitOverride",
  "noImplicitReturns",
  "noPropertyAccessFromIndexSignature",
  "noUncheckedIndexedAccess",
  "noUncheckedSideEffectImports",
  "noUnusedLocals",
  "noUnusedParameters",
  "verbatimModuleSyntax",
];

const LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

/**
 * E1 rule engine on the TypeScript compiler (ADR-0027). Rules are compiler checks such as
 * `tsc:noUncheckedIndexedAccess`, enabled or not according to `tsc --showConfig`; findings
 * are the project's type errors (`tsc --noEmit`). A rule holds while the option is on and the
 * project typechecks.
 */
export class TscEngine implements RuleEngine {
  readonly engine = "tsc";

  constructor(
    private readonly runner: ProcessRunner,
    private readonly root: string,
    private readonly project = "tsconfig.json",
  ) {}

  async rules(): Promise<Result<readonly EngineRule[], MetatorError>> {
    if (!existsSync(join(this.root, this.project))) return ok([]);
    const r = await this.tsc(["--showConfig", "-p", this.project]);
    if (r.isErr()) return err(r.error);
    let options: Record<string, unknown>;
    try {
      options =
        (JSON.parse(r.value.stdout) as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {};
    } catch {
      return err(
        new MetatorError("COMMAND_FAILED", "tsc --showConfig did not print JSON", {
          details: { stdout: r.value.stdout.slice(0, 200) },
        }),
      );
    }
    const on = (name: string) =>
      options[name] === true ||
      (STRICT_FAMILY.includes(name) && options.strict === true && options[name] !== false);
    return ok(
      CHECKS.map((id) => ({ id, source: this.project, hasTest: true, enabled: on(id) })).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
  }

  async check(files?: readonly string[]): Promise<Result<readonly Diagnostic[], MetatorError>> {
    if (!existsSync(join(this.root, this.project))) return ok([]);
    const r = await this.tsc(["--noEmit", "--pretty", "false", "-p", this.project]);
    if (r.isErr()) return err(r.error);
    const diagnostics: Diagnostic[] = [];
    for (const line of r.value.stdout.split("\n")) {
      const m = LINE.exec(line.trim());
      if (!m) continue;
      diagnostics.push({
        source: this.engine,
        toolRuleId: m[5] as string,
        file: normalizePath(m[1] as string),
        line: Number(m[2]),
        column: Number(m[3]),
        severity: m[4] === "error" ? "error" : "warning",
        message: m[6] as string,
      });
    }
    if (r.value.exitCode !== 0 && diagnostics.length === 0) {
      return err(
        new MetatorError("COMMAND_FAILED", `tsc failed (exit ${r.value.exitCode})`, {
          details: { output: `${r.value.stdout}${r.value.stderr}`.trim().slice(0, 500) },
        }),
      );
    }
    // tsc checks the whole program; report only the requested files when there are any.
    return ok(files ? diagnostics.filter((d) => files.includes(d.file)) : diagnostics);
  }

  private async tsc(
    args: string[],
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, MetatorError>> {
    const local = join(this.root, "node_modules", ".bin", "tsc");
    const r = await this.runner.run(
      { argv: [existsSync(local) ? local : "tsc", ...args], cwd: this.root },
      { timeoutMs: 300_000 },
    );
    if (r.exitCode === 127) {
      return err(
        new MetatorError("BIN_NOT_FOUND", "tsc is not installed", {
          hint: "Install TypeScript with `bun add -d typescript` (or npm/pnpm/yarn).",
        }),
      );
    }
    return ok(r);
  }
}
