import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Diagnostic,
  type EngineRule,
  err,
  MetatorError,
  ok,
  outputTail,
  type ProcessRunner,
  type Result,
  type RuleEngine,
} from "@metator/core";

/** A conformance test proves its own check with at least one `test("rejects ...")` case. */
const REJECTS_CASE = /\btest\(\s*["'`]rejects\b/;
/** Lines of `bun test` output that say what failed. */
const FAILURE_LINE = /^(\(fail\)|error:|\s*[-+] |\s*(Expected|Received)\b)/;

/**
 * E1 rule engine on conformance tests (ADR-0034): a rule `test:<id>` holds while
 * `<dir>/<id>.test.ts` passes under `bun test`. Conformance tests check what one file cannot
 * show (every command has an e2e test, every adapter runs its contract suite), so they read
 * the whole repository and ignore the changed-file list.
 */
export class BunTestEngine implements RuleEngine {
  readonly engine = "test";

  constructor(
    private readonly runner: ProcessRunner,
    private readonly root: string,
    private readonly dir = "rules/conformance",
  ) {}

  async rules(): Promise<Result<readonly EngineRule[], MetatorError>> {
    if (!existsSync(join(this.root, this.dir))) return ok([]);
    const rules: EngineRule[] = [];
    for await (const rel of new Bun.Glob("*.test.ts").scan({ cwd: join(this.root, this.dir) })) {
      const source = `${this.dir}/${rel}`;
      const text = await Bun.file(join(this.root, source)).text();
      rules.push({ id: rel.replace(/\.test\.ts$/, ""), source, hasTest: REJECTS_CASE.test(text) });
    }
    return ok(rules.sort((a, b) => a.id.localeCompare(b.id)));
  }

  async check(): Promise<Result<readonly Diagnostic[], MetatorError>> {
    const rules = await this.rules();
    if (rules.isErr()) return err(rules.error);
    const diagnostics: Diagnostic[] = [];
    for (const rule of rules.value) {
      const r = await this.runner.run(
        { argv: [process.execPath, "test", `./${rule.source}`], cwd: this.root },
        { timeoutMs: 120_000 },
      );
      if (r.exitCode === 0) continue;
      if (r.exitCode === 127) return err(new MetatorError("BIN_NOT_FOUND", "bun is not installed"));
      const output = `${r.stdout}\n${r.stderr}`;
      const failures = output.split("\n").filter((l) => FAILURE_LINE.test(l));
      diagnostics.push({
        source: this.engine,
        toolRuleId: rule.id,
        file: rule.source,
        severity: "error",
        message: outputTail(failures.length > 0 ? failures.join("\n") : output),
      });
    }
    return ok(diagnostics);
  }
}
