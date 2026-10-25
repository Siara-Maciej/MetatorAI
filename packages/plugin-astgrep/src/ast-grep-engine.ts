import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Diagnostic,
  type EngineRule,
  err,
  MetatorError,
  ok,
  type ProcessRunner,
  type Result,
  type RuleEngine,
  type Severity,
} from "@metator/core";
import { parseAllDocuments } from "yaml";

interface SgConfig {
  readonly ruleDirs?: readonly string[];
  readonly testConfigs?: readonly { readonly testDir: string }[];
}

interface SgMatch {
  readonly ruleId: string;
  readonly file: string;
  readonly severity: string;
  readonly message: string;
  readonly range: { readonly start: { readonly line: number; readonly column: number } };
}

const SEVERITY: Readonly<Record<string, Severity>> = { error: "error", warning: "warning" };

/**
 * E1 rule engine on the ast-grep CLI (ADR-0020): rules come from `sgconfig.yml` (`ruleDirs`,
 * with tests from `testConfigs`), findings from `ast-grep scan --json=stream`. The repo's own
 * `node_modules/.bin/ast-grep` wins over one on PATH, so the pinned version runs.
 */
export class AstGrepEngine implements RuleEngine {
  readonly engine = "ast-grep";

  constructor(
    private readonly runner: ProcessRunner,
    private readonly root: string,
  ) {}

  async rules(): Promise<Result<readonly EngineRule[], MetatorError>> {
    const config = await this.config();
    if (config.isErr()) return err(config.error);
    if (!config.value) return ok([]);
    const tested = new Set<string>();
    for (const dir of (config.value.testConfigs ?? []).map((t) => t.testDir)) {
      for (const { id } of await this.ids(dir)) tested.add(id);
    }
    const rules: EngineRule[] = [];
    for (const dir of config.value.ruleDirs ?? []) {
      for (const { id, source } of await this.ids(dir)) rules.push({ id, source, hasTest: tested.has(id) });
    }
    return ok(rules.sort((a, b) => a.id.localeCompare(b.id)));
  }

  async check(files?: readonly string[]): Promise<Result<readonly Diagnostic[], MetatorError>> {
    const config = await this.config();
    if (config.isErr()) return err(config.error);
    if (!config.value) return ok([]);
    // ast-grep fails on paths that do not exist (e.g. files deleted on the branch).
    const targets = files?.filter((f) => existsSync(join(this.root, f)));
    if (targets && targets.length === 0) return ok([]);

    const r = await this.runner.run(
      { argv: [this.binary(), "scan", "--json=stream", ...(targets ?? [])], cwd: this.root },
      { timeoutMs: 120_000 },
    );
    if (r.exitCode === 127) {
      return err(
        new MetatorError("BIN_NOT_FOUND", "ast-grep is not installed", {
          hint: "Install it with `bun add -d @ast-grep/cli` (or npm/pnpm/yarn).",
        }),
      );
    }
    // Exit 1 only means "error-level findings"; anything else non-zero without output is a failure.
    if (r.exitCode !== 0 && r.exitCode !== 1) return err(failed(r.exitCode, r.stderr));
    const diagnostics: Diagnostic[] = [];
    for (const line of r.stdout.split("\n")) {
      if (line.trim() === "") continue;
      let match: SgMatch;
      try {
        match = JSON.parse(line) as SgMatch;
      } catch {
        return err(failed(r.exitCode, `unexpected output: ${line.slice(0, 200)}`));
      }
      diagnostics.push({
        source: this.engine,
        toolRuleId: match.ruleId,
        file: match.file,
        line: match.range.start.line + 1,
        column: match.range.start.column + 1,
        severity: SEVERITY[match.severity] ?? "info",
        message: match.message,
      });
    }
    if (r.exitCode === 1 && diagnostics.length === 0) return err(failed(r.exitCode, r.stderr));
    // ast-grep scans in parallel; sort so the output is deterministic.
    return ok(
      diagnostics.sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          (a.line ?? 0) - (b.line ?? 0) ||
          (a.column ?? 0) - (b.column ?? 0) ||
          (a.toolRuleId ?? "").localeCompare(b.toolRuleId ?? ""),
      ),
    );
  }

  private binary(): string {
    const local = join(this.root, "node_modules", ".bin", "ast-grep");
    return existsSync(local) ? local : "ast-grep";
  }

  private async config(): Promise<Result<SgConfig | undefined, MetatorError>> {
    const file = join(this.root, "sgconfig.yml");
    if (!existsSync(file)) return ok(undefined);
    const docs = parseAllDocuments(await Bun.file(file).text());
    const first = Array.isArray(docs) ? docs[0] : undefined;
    if (!first || first.errors.length > 0) {
      return err(
        new MetatorError(
          "INVALID_CONFIG",
          `sgconfig.yml: ${first?.errors[0]?.message ?? "not a YAML document"}`,
        ),
      );
    }
    return ok((first.toJS() ?? {}) as SgConfig);
  }

  /** Rule ids declared in the YAML files of a directory (a file may hold several `---` documents). */
  private async ids(dir: string): Promise<{ id: string; source: string }[]> {
    if (!existsSync(join(this.root, dir))) return [];
    const found: { id: string; source: string }[] = [];
    for (const pattern of ["**/*.yml", "**/*.yaml"]) {
      for await (const rel of new Bun.Glob(pattern).scan({ cwd: join(this.root, dir) })) {
        const source = `${dir.replace(/\/$/, "")}/${rel}`;
        const docs = parseAllDocuments(await Bun.file(join(this.root, source)).text());
        for (const doc of Array.isArray(docs) ? docs : []) {
          const id = (doc.toJS() as { id?: unknown } | null)?.id;
          if (typeof id === "string") found.push({ id, source });
        }
      }
    }
    return found;
  }
}

function failed(exitCode: number, stderr: string): MetatorError {
  return new MetatorError("COMMAND_FAILED", `ast-grep scan failed (exit ${exitCode})`, {
    details: { stderr: stderr.trim().slice(0, 500) },
  });
}
