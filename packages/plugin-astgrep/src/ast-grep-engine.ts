import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type BinResolver,
  type Diagnostic,
  diagnosticsFromSarif,
  type EngineRule,
  err,
  MetatorError,
  ok,
  type ProcessRunner,
  type Result,
  type RuleEngine,
  runTool,
  type SarifLog,
} from "@metator/core";
import { parseAllDocuments } from "yaml";

interface SgConfig {
  readonly ruleDirs?: readonly string[];
  readonly testConfigs?: readonly { readonly testDir: string }[];
}

/**
 * E1 rule engine on the ast-grep CLI (ADR-0020): rules come from `sgconfig.yml` (`ruleDirs`,
 * with tests from `testConfigs`), findings from `ast-grep scan --format sarif`. The repo's own
 * `node_modules/.bin/ast-grep` wins over one on PATH (`bins`), so the pinned version runs.
 */
export class AstGrepEngine implements RuleEngine {
  readonly engine = "ast-grep";

  constructor(
    private readonly runner: ProcessRunner,
    private readonly root: string,
    private readonly bins: BinResolver,
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

    const run = await runTool(this.runner, this.bins, {
      bin: "ast-grep",
      args: ["scan", "--format", "sarif", ...(targets ?? [])],
      hint: "Install it with `bun add -d @ast-grep/cli` (or npm/pnpm/yarn).",
      timeoutMs: 120_000,
    });
    if (run.isErr()) return err(run.error);
    const r = run.value;
    // Exit 1 only means "error-level findings"; anything else non-zero without output is a failure.
    if (r.exitCode !== 0 && r.exitCode !== 1) return err(failed(r.exitCode, r.stderr));
    let log: SarifLog = {};
    if (r.exitCode === 1 || r.stdout.trim() !== "") {
      try {
        log = JSON.parse(r.stdout) as SarifLog;
      } catch {
        return err(failed(r.exitCode, r.stderr.trim() || `unexpected output: ${r.stdout.slice(0, 200)}`));
      }
    }
    const diagnostics = diagnosticsFromSarif(asUris(log), this.root, this.engine);
    if (r.exitCode === 1 && diagnostics.length === 0) return err(failed(r.exitCode, r.stderr));
    // ast-grep scans in parallel; two rules at one position are ordered by rule so the output is deterministic.
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

/** ast-grep writes plain paths where SARIF has URIs: a `%` or a space in a file name is escaped here. */
function asUris(log: SarifLog): SarifLog {
  return {
    ...log,
    runs: (log.runs ?? []).map((run) => ({
      ...run,
      results: (run.results ?? []).map((result) => ({
        ...result,
        locations: (result.locations ?? []).map((l) => {
          const uri = l.physicalLocation?.artifactLocation?.uri;
          return uri === undefined
            ? l
            : { physicalLocation: { ...l.physicalLocation, artifactLocation: { uri: encodeURI(uri) } } };
        }),
      })),
    })),
  };
}

function failed(exitCode: number, stderr: string): MetatorError {
  return new MetatorError("COMMAND_FAILED", `ast-grep scan failed (exit ${exitCode})`, {
    details: { stderr: stderr.trim().slice(0, 500) },
  });
}
