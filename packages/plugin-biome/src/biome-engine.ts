import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Diagnostic,
  diagnosticsFromSarif,
  type EngineRule,
  err,
  MetatorError,
  ok,
  type ProcessRunner,
  type Result,
  type RuleEngine,
  type SarifLog,
} from "@metator/core";

const CONFIG_FILES = ["biome.json", "biome.jsonc"];
const NOT_GROUPS = new Set(["preset", "recommended", "all"]);

/**
 * E1 rule engine on Biome (ADR-0025). Rules are `lint/<group>/<rule>` ids read from the installed
 * Biome's configuration schema (Biome tests its own rules, so every rule counts as tested).
 * Findings come from `biome lint --reporter=sarif`. Repos without a Biome config are skipped:
 * running Biome's defaults there would report rules nobody chose.
 */
export class BiomeEngine implements RuleEngine {
  readonly engine = "biome";

  constructor(
    private readonly runner: ProcessRunner,
    private readonly root: string,
  ) {}

  async rules(): Promise<Result<readonly EngineRule[], MetatorError>> {
    const schemaFile = join(this.root, "node_modules/@biomejs/biome/configuration_schema.json");
    if (!existsSync(schemaFile)) return ok([]);
    let schema: { $defs?: Record<string, { properties?: Record<string, unknown> }> };
    try {
      schema = (await Bun.file(schemaFile).json()) as typeof schema;
    } catch (e) {
      return err(new MetatorError("INVALID_CONFIG", `Unreadable Biome schema: ${(e as Error).message}`));
    }
    const defs = schema.$defs ?? {};
    const groups = Object.keys(defs.Rules?.properties ?? {}).filter((g) => !NOT_GROUPS.has(g));
    const rules: EngineRule[] = [];
    for (const group of groups) {
      const def = defs[group[0]?.toUpperCase() + group.slice(1)] ?? defs[group];
      for (const name of Object.keys(def?.properties ?? {})) {
        if (NOT_GROUPS.has(name)) continue;
        rules.push({ id: `lint/${group}/${name}`, source: "@biomejs/biome", hasTest: true });
      }
    }
    const enabled = await this.enabledRules();
    const marked = enabled ? rules.map((r) => ({ ...r, enabled: enabled.has(r.id) })) : rules;
    return ok(marked.sort((a, b) => a.id.localeCompare(b.id)));
  }

  /**
   * Rules the repo's config turns on, from `biome rage --linter` ("Enabled rules:" block).
   * Undefined when the repo has no Biome config or the output cannot be read: then nothing
   * is claimed either way.
   */
  private async enabledRules(): Promise<Set<string> | undefined> {
    if (!CONFIG_FILES.some((f) => existsSync(join(this.root, f)))) return undefined;
    const r = await this.runner.run(
      { argv: [this.binary(), "rage", "--linter"], cwd: this.root },
      { timeoutMs: 60_000 },
    );
    if (r.exitCode !== 0) return undefined;
    const block = r.stdout.split(/^\s*Enabled rules:\s*$/m)[1];
    if (block === undefined) return undefined;
    const enabled = new Set<string>();
    for (const line of block.split("\n")) {
      const m = /^\s+([a-zA-Z0-9]+)\/([a-zA-Z0-9]+)\s*$/.exec(line);
      if (m) enabled.add(`lint/${m[1]}/${m[2]}`);
      else if (enabled.size > 0 && line.trim() !== "") break;
    }
    return enabled.size > 0 ? enabled : undefined;
  }

  async check(files?: readonly string[]): Promise<Result<readonly Diagnostic[], MetatorError>> {
    if (!CONFIG_FILES.some((f) => existsSync(join(this.root, f)))) return ok([]);
    const targets = files?.filter((f) => existsSync(join(this.root, f)));
    if (targets && targets.length === 0) return ok([]);
    const r = await this.runner.run(
      {
        argv: [
          this.binary(),
          "lint",
          "--reporter=sarif",
          "--max-diagnostics=none",
          "--files-ignore-unknown=true",
          "--no-errors-on-unmatched",
          ...(targets ?? ["."]),
        ],
        cwd: this.root,
      },
      { timeoutMs: 120_000 },
    );
    if (r.exitCode === 127) {
      return err(
        new MetatorError("BIN_NOT_FOUND", "biome is not installed", {
          hint: "Install it with `bun add -d @biomejs/biome` (or npm/pnpm/yarn).",
        }),
      );
    }
    let log: SarifLog;
    try {
      log = JSON.parse(r.stdout) as SarifLog;
    } catch {
      return err(
        new MetatorError("COMMAND_FAILED", `biome lint failed (exit ${r.exitCode})`, {
          details: { stderr: r.stderr.trim().slice(0, 500), stdout: r.stdout.slice(0, 200) },
        }),
      );
    }
    return ok(diagnosticsFromSarif(log, this.root, this.engine));
  }

  private binary(): string {
    const local = join(this.root, "node_modules", ".bin", "biome");
    return existsSync(local) ? local : "biome";
  }
}
