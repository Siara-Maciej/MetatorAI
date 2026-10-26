import type { Diagnostic } from "../domain/diagnostic.ts";
import { MetatorError } from "../domain/errors.ts";
import { markdownAnchors } from "../domain/markdown.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  areaOf,
  estimateTokens,
  InstructionsAdapterDocument,
  parseImplementation,
  prefixOf,
  type Rule,
  type RuleSet,
  RuleSetDocument,
  rulesFor,
} from "../domain/rule.ts";
import { parseYamlDocument, readFrontMatter, renderFrontMatter } from "../domain/versioned.ts";
import type {
  EngineRule,
  FileSystem,
  ReadonlyFileSystem,
  RuleEngine,
  RuleScaffolder,
  Vcs,
} from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";

export interface RuleSetEntry {
  readonly set: RuleSet;
  readonly source: string;
}

export interface RuleEntry {
  readonly rule: Rule;
  readonly area: string;
  readonly source: string;
}

export interface RuleCatalogScan {
  readonly sets: readonly RuleSetEntry[];
  readonly rules: readonly RuleEntry[];
  readonly problems: readonly { readonly source: string; readonly error: MetatorError }[];
}

/** The rule canon: every `RuleSet` YAML document under `paths.rules`. */
export class RuleCatalog {
  constructor(
    private readonly fs: ReadonlyFileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async scan(): Promise<RuleCatalogScan> {
    const files = await this.fs.glob([`${this.paths.rules}/*.yml`, `${this.paths.rules}/*.yaml`]);
    const sets: RuleSetEntry[] = [];
    const problems: { source: string; error: MetatorError }[] = [];
    for (const source of [...files].sort()) {
      const text = await this.fs.read(source);
      const set = text
        .andThen((t) => parseYamlDocument(t, source))
        .andThen((raw) => RuleSetDocument.parse(raw, source));
      if (set.isOk()) sets.push({ set: set.value, source });
      else problems.push({ source, error: set.error });
    }
    const rules = sets.flatMap(({ set, source }) =>
      set.rules.map((rule) => ({ rule, area: set.area, source })),
    );
    return { sets, rules, problems };
  }

  async get(id: string): Promise<Result<RuleEntry, MetatorError>> {
    const scan = await this.scan();
    const entry = scan.rules.find((r) => r.rule.id === id);
    if (entry) return ok(entry);
    return err(
      new MetatorError("NOT_FOUND", `Rule ${id} not found`, {
        hint: `Rules live in ${this.paths.rules}/*.yml; \`metator rules lint\` lists them.`,
      }),
    );
  }
}

// ── rules lint ──────────────────────────────────────────────────────────────────

export interface LintProblem {
  readonly source: string;
  readonly ruleId?: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface RulesLintReport {
  readonly sets: number;
  readonly rules: number;
  readonly byEnforcement: Readonly<Record<"E1" | "E2" | "E3", number>>;
  readonly problems: readonly LintProblem[];
}

/**
 * Validates the canon: schema, unique immutable IDs, one ID prefix, areas, links to rationale
 * and sources, rule references, and that every E1 rule exists (with a test) in its engine.
 */
export class LintRules {
  constructor(
    private readonly catalog: RuleCatalog,
    private readonly fs: ReadonlyFileSystem,
    private readonly sources: SourceFiles,
    private readonly engines: readonly RuleEngine[],
  ) {}

  async execute(): Promise<Result<RulesLintReport, MetatorError>> {
    const scan = await this.catalog.scan();
    const problems: LintProblem[] = scan.problems.map((p) => ({
      source: p.source,
      severity: "error",
      message: p.error.message,
    }));
    const error = (entry: RuleEntry, message: string) =>
      problems.push({ source: entry.source, ruleId: entry.rule.id, severity: "error", message });
    const warning = (entry: RuleEntry, message: string) =>
      problems.push({ source: entry.source, ruleId: entry.rule.id, severity: "warning", message });

    const ids = new Map<string, string>();
    const prefixes = new Set(scan.rules.map((r) => prefixOf(r.rule.id)));
    for (const entry of scan.rules) {
      const { rule } = entry;
      const first = ids.get(rule.id);
      if (first) error(entry, `duplicate rule id ${rule.id} (first defined in ${first})`);
      else ids.set(rule.id, entry.source);
      if (areaOf(rule.id) !== entry.area) error(entry, `${rule.id} is not in area ${entry.area}`);
    }
    if (prefixes.size > 1) {
      problems.push({
        source: this.catalogDir(scan),
        severity: "error",
        message: `rule ids use several prefixes (${[...prefixes].sort().join(", ")}); use one`,
      });
    }

    const files = await this.sources.list();
    if (files.isErr()) return err(files.error);
    const engineRules = await loadEngineRules(this.engines);
    if (engineRules.isErr()) return err(engineRules.error);

    for (const entry of scan.rules) {
      const { rule } = entry;
      for (const ref of [rule.rationale, rule.source.ref]) {
        if (!(await this.linkExists(ref))) error(entry, `link target not found: ${ref}`);
      }
      for (const other of [...rule.conflictsWith, ...(rule.supersededBy ? [rule.supersededBy] : [])]) {
        if (!ids.has(other)) error(entry, `references unknown rule ${other}`);
      }
      if (rule.implementation) {
        const { engine, ruleId } = parseImplementation(rule.implementation);
        const known = engineRules.value.get(engine);
        if (!known) warning(entry, `no adapter for engine "${engine}": implementation not verified`);
        else {
          const found = known.find((r) => r.id === ruleId);
          if (!found) error(entry, `${rule.implementation} does not exist (engine rules: ${known.length})`);
          else if (!found.hasTest) error(entry, `${rule.implementation} has no test (${found.source})`);
          else if (found.enabled === false)
            error(entry, `${rule.implementation} is not enabled in the tool's configuration`);
        }
      }
      if (rule.status === "active") {
        const positive = rule.applyTo.filter((g) => !g.startsWith("!"));
        const matched = files.value.some((f) => rulesFor([rule], [f]).length > 0);
        if (positive.length > 0 && !matched) warning(entry, `applyTo matches no file in the repository`);
      }
    }

    const count = (level: Rule["enforcement"]) =>
      scan.rules.filter((r) => r.rule.enforcement === level).length;
    return ok({
      sets: scan.sets.length,
      rules: scan.rules.length,
      byEnforcement: { E1: count("E1"), E2: count("E2"), E3: count("E3") },
      problems,
    });
  }

  private catalogDir(scan: RuleCatalogScan): string {
    return scan.sets[0]?.source.replace(/\/[^/]+$/, "") ?? "rules";
  }

  /** `path`, `path#anchor` or `#anchor`-less refs; Markdown anchors must match a heading. */
  private async linkExists(ref: string): Promise<boolean> {
    if (/^https?:\/\//.test(ref)) return true;
    const [path = "", anchor] = ref.split("#");
    if (path === "") return true;
    const text = await this.fs.read(path);
    if (text.isErr()) return false;
    if (!anchor || !/\.md$/i.test(path)) return true;
    return markdownAnchors(text.value).has(anchor);
  }
}

type EngineRuleMap = Map<string, readonly EngineRule[]>;

async function loadEngineRules(engines: readonly RuleEngine[]): Promise<Result<EngineRuleMap, MetatorError>> {
  const byEngine: EngineRuleMap = new Map();
  for (const engine of engines) {
    const rules = await engine.rules();
    if (rules.isErr()) return err(rules.error);
    byEngine.set(engine.engine, rules.value);
  }
  return ok(byEngine);
}

// ── rules coverage ──────────────────────────────────────────────────────────────

export interface AreaCoverage {
  readonly area: string;
  readonly active: number;
  readonly E1: number;
  readonly E2: number;
  readonly E3: number;
  /** Share of active rules a tool enforces, 0–100. */
  readonly e1Percent: number;
}

export interface RulesCoverage {
  readonly total: AreaCoverage;
  readonly byArea: readonly AreaCoverage[];
  /** E1 rules whose tool rule has no test. */
  readonly e1WithoutTest: readonly string[];
  /** E1 rules bound to an engine MetatorAI has no adapter for. */
  readonly e1Unverified: readonly string[];
  /** E1 rules whose tool rule exists but is turned off in the tool's config. */
  readonly e1Disabled: readonly string[];
  /** Active rules whose applyTo matches no file. */
  readonly dead: readonly string[];
  /** E2 rules without a do or don't example (hard to check in review). */
  readonly e2WithoutExamples: readonly string[];
}

/** How much of the canon tools enforce, and where enforcement or examples are missing. */
export class MeasureRuleCoverage {
  constructor(
    private readonly catalog: RuleCatalog,
    private readonly sources: SourceFiles,
    private readonly engines: readonly RuleEngine[],
  ) {}

  async execute(): Promise<Result<RulesCoverage, MetatorError>> {
    const scan = await this.catalog.scan();
    if (scan.problems.length > 0) return err(invalidCanon(scan));
    const files = await this.sources.list();
    if (files.isErr()) return err(files.error);
    const engineRules = await loadEngineRules(this.engines);
    if (engineRules.isErr()) return err(engineRules.error);

    const active = scan.rules.filter((r) => r.rule.status === "active");
    const coverage = (area: string, rules: readonly RuleEntry[]): AreaCoverage => {
      const count = (level: Rule["enforcement"]) => rules.filter((r) => r.rule.enforcement === level).length;
      const E1 = count("E1");
      return {
        area,
        active: rules.length,
        E1,
        E2: count("E2"),
        E3: count("E3"),
        e1Percent: rules.length === 0 ? 0 : Math.round((E1 / rules.length) * 100),
      };
    };
    const areas = [...new Set(active.map((r) => r.area))].sort();

    const e1WithoutTest: string[] = [];
    const e1Unverified: string[] = [];
    const e1Disabled: string[] = [];
    for (const { rule } of active) {
      if (!rule.implementation) continue;
      const { engine, ruleId } = parseImplementation(rule.implementation);
      const known = engineRules.value.get(engine);
      const found = known?.find((r) => r.id === ruleId);
      if (!known) e1Unverified.push(rule.id);
      else if (found?.enabled === false) e1Disabled.push(rule.id);
      else if (!found?.hasTest) e1WithoutTest.push(rule.id);
    }
    return ok({
      total: coverage("all", active),
      byArea: areas.map((a) =>
        coverage(
          a,
          active.filter((r) => r.area === a),
        ),
      ),
      e1WithoutTest,
      e1Unverified,
      e1Disabled,
      dead: active
        .filter((r) => !files.value.some((f) => rulesFor([r.rule], [f]).length > 0))
        .map((r) => r.rule.id),
      e2WithoutExamples: active
        .filter((r) => r.rule.enforcement === "E2" && r.rule.do.length + r.rule.dont.length === 0)
        .map((r) => r.rule.id),
    });
  }
}

// ── rules scaffold ──────────────────────────────────────────────────────────────

export interface ScaffoldReport {
  readonly rule: string;
  readonly implementation: string;
  readonly files: readonly string[];
  readonly next: readonly string[];
}

/** First step from E2/E3 to E1: the tool rule skeleton and its (failing) test for a canon rule. */
export class ScaffoldRule {
  constructor(
    private readonly catalog: RuleCatalog,
    private readonly scaffolders: readonly RuleScaffolder[],
  ) {}

  async execute(input: {
    readonly id: string;
    readonly engine: string;
  }): Promise<Result<ScaffoldReport, MetatorError>> {
    const entry = await this.catalog.get(input.id);
    if (entry.isErr()) return err(entry.error);
    const { rule, source } = entry.value;
    if (rule.implementation) {
      return err(MetatorError.usage(`${rule.id} is already enforced by ${rule.implementation}`));
    }
    const scaffolder = this.scaffolders.find((s) => s.engine === input.engine);
    if (!scaffolder) {
      return err(
        MetatorError.usage(
          `No scaffolder for engine "${input.engine}"`,
          `Available: ${this.scaffolders.map((s) => s.engine).join(", ") || "none"}.`,
        ),
      );
    }
    const ruleId = rule.id.toLowerCase();
    const written = await scaffolder.scaffold({
      ruleId,
      message: `${rule.id}: ${rule.title}`,
      files: rule.applyTo.filter((g) => !g.startsWith("!")),
    });
    if (written.isErr()) return err(written.error);
    const implementation = `${input.engine}:${ruleId}`;
    return ok({
      rule: rule.id,
      implementation,
      files: written.value.files,
      next: [
        `Write the rule and real valid/invalid cases in ${written.value.files.join(" and ")} (the test fails until you do).`,
        `In ${source}, set ${rule.id} to enforcement: E1 and implementation: ${implementation}.`,
        "Run `bun run arch` (or your ast-grep test command) and `metator rules lint`.",
      ],
    });
  }
}

// ── rules pack ──────────────────────────────────────────────────────────────────

export interface PackedRule {
  readonly id: string;
  readonly title: string;
  readonly enforcement: "E2" | "E3";
  readonly summary: string;
  readonly applyTo: readonly string[];
  readonly do: readonly string[];
  readonly dont: readonly string[];
}

export interface RulePack {
  readonly paths: readonly string[];
  /** Rules the agent must apply itself (E2 before E3), within the token budget. */
  readonly rules: readonly PackedRule[];
  /** E1 rules: a tool enforces them, so the agent only needs to know they exist. */
  readonly enforcedByTools: readonly {
    readonly id: string;
    readonly title: string;
    readonly implementation: string;
  }[];
  /** Rules that did not fit the budget; `metator rules show <id>` prints one. */
  readonly omitted: readonly string[];
  readonly tokens: number;
}

export const DEFAULT_PACK_TOKENS = 2000;

/** Only the rules that apply to the given paths, sized for an agent's context. */
export class PackRules {
  constructor(private readonly catalog: RuleCatalog) {}

  async execute(input: {
    readonly paths: readonly string[];
    readonly budgetTokens?: number;
  }): Promise<Result<RulePack, MetatorError>> {
    const scan = await this.catalog.scan();
    if (scan.problems.length > 0) return err(invalidCanon(scan));
    const applicable = rulesFor(
      scan.rules.map((r) => r.rule),
      input.paths,
    );
    const order = { E2: 0, E3: 1, E1: 2 } as const;
    applicable.sort((a, b) => order[a.enforcement] - order[b.enforcement] || a.id.localeCompare(b.id));

    const enforcedByTools = applicable
      .filter((r) => r.enforcement === "E1")
      .map((r) => ({ id: r.id, title: r.title, implementation: r.implementation as string }));
    const budget = input.budgetTokens ?? DEFAULT_PACK_TOKENS;
    let tokens = estimateTokens(JSON.stringify(enforcedByTools));
    const rules: PackedRule[] = [];
    const omitted: string[] = [];
    for (const r of applicable) {
      if (r.enforcement === "E1") continue;
      const packed: PackedRule = {
        id: r.id,
        title: r.title,
        enforcement: r.enforcement,
        summary: r.summary,
        applyTo: r.applyTo,
        do: r.do,
        dont: r.dont,
      };
      const cost = estimateTokens(JSON.stringify(packed));
      if (tokens + cost > budget) {
        omitted.push(r.id);
        continue;
      }
      tokens += cost;
      rules.push(packed);
    }
    return ok({ paths: [...input.paths].sort(), rules, enforcedByTools, omitted, tokens });
  }
}

// ── rules adapters ──────────────────────────────────────────────────────────────

export interface AdaptersReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  /** In check mode: files that differ from the canon. */
  readonly stale: readonly string[];
  /** Generated files whose rule set no longer exists or has no active rules. */
  readonly orphaned: readonly string[];
}

/**
 * Generates one host instruction file per rule area from the canon, so instructions are never
 * a hand-kept copy. `check` compares instead of writing (CI fails on drift).
 */
export class GenerateRuleAdapters {
  constructor(
    private readonly catalog: RuleCatalog,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async execute(input: { readonly check: boolean }): Promise<Result<AdaptersReport, MetatorError>> {
    const scan = await this.catalog.scan();
    if (scan.problems.length > 0) return err(invalidCanon(scan));

    const expected = new Map<string, string>();
    for (const entry of scan.sets) {
      const active = entry.set.rules.filter((r) => r.status === "active");
      if (active.length === 0) continue;
      const prefix = prefixOf(active[0]?.id as string).toLowerCase();
      const file = `${this.paths.instructions}/${prefix}-${entry.set.area.toLowerCase()}.instructions.md`;
      expected.set(file, renderAdapter(entry, active));
    }

    const written: string[] = [];
    const unchanged: string[] = [];
    const stale: string[] = [];
    for (const [file, content] of [...expected].sort(([a], [b]) => a.localeCompare(b))) {
      const current = await this.fs.read(file);
      if (current.isOk() && current.value === content) {
        unchanged.push(file);
        continue;
      }
      if (input.check) {
        stale.push(file);
        continue;
      }
      const saved = await this.fs.write(file, content);
      if (saved.isErr()) return err(saved.error);
      written.push(file);
    }

    const orphaned: string[] = [];
    for (const file of await this.fs.glob([`${this.paths.instructions}/*.instructions.md`])) {
      if (expected.has(file)) continue;
      const text = await this.fs.read(file);
      const header = text.andThen((t) => readFrontMatter(t, file));
      if (
        header.isOk() &&
        (header.value as { kind?: unknown } | null)?.kind === InstructionsAdapterDocument.kind
      ) {
        orphaned.push(file);
      }
    }
    return ok({ written, unchanged, stale, orphaned: orphaned.sort() });
  }
}

function renderAdapter(entry: RuleSetEntry, active: readonly Rule[]): string {
  const globs = [...new Set(active.flatMap((r) => r.applyTo.filter((g) => !g.startsWith("!"))))].sort();
  const header = InstructionsAdapterDocument.stamp({
    applyTo: globs.join(","),
    description: entry.set.description ?? `${entry.set.area} rules`,
    generatedFrom: entry.source,
  });
  const lines = [
    "",
    `<!-- Generated by \`metator rules adapters\` from ${entry.source}. Do not edit: change the canon. -->`,
    "",
    `# ${entry.set.area} rules`,
    "",
  ];
  if (entry.set.description) lines.push(entry.set.description.trim(), "");
  for (const r of active.filter((x) => x.enforcement !== "E1")) {
    lines.push(`## ${r.id}: ${r.title}`, "", r.summary, "");
    if (!sameGlobs(r.applyTo, globs))
      lines.push(`Applies to: ${r.applyTo.map((g) => `\`${g}\``).join(", ")}`, "");
    for (const d of r.do) lines.push(`- Do: ${asCode(d)}`);
    for (const d of r.dont) lines.push(`- Don't: ${asCode(d)}`);
    if (r.do.length + r.dont.length > 0) lines.push("");
  }
  const tools = active.filter((x) => x.enforcement === "E1");
  if (tools.length > 0) {
    lines.push("## Enforced by tools", "", "CI fails on these; no need to re-check them by hand.", "");
    for (const r of tools) lines.push(`- ${r.id}: ${r.title} (\`${r.implementation}\`)`);
    lines.push("");
  }
  return renderFrontMatter(header, lines.join("\n"));
}

/** Examples are code spans; a longer delimiter keeps backticks inside the example intact. */
function asCode(example: string): string {
  const longest = Math.max(0, ...[...example.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return longest === 0 ? `${fence}${example}${fence}` : `${fence} ${example} ${fence}`;
}

function sameGlobs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((g, i) => g === b[i]);
}

// ── rules check ─────────────────────────────────────────────────────────────────

export interface RuleViolation extends Diagnostic {
  readonly engine: string;
}

export interface RulesCheckReport {
  readonly engines: readonly string[];
  readonly files: number | "all";
  readonly violations: readonly RuleViolation[];
}

/** Runs every E1 engine and maps tool rule ids back to canon rule ids (`canonRuleId`). */
export class CheckRules {
  constructor(
    private readonly catalog: RuleCatalog,
    private readonly engines: readonly RuleEngine[],
    private readonly vcs: Vcs,
  ) {}

  async execute(input: {
    readonly files?: readonly string[];
    readonly base?: string;
  }): Promise<Result<RulesCheckReport, MetatorError>> {
    let files = input.files;
    if (!files && input.base) {
      const changed = await this.vcs.changedFiles(input.base);
      if (changed.isErr()) return err(changed.error);
      files = changed.value;
    }
    if (files && files.length === 0) return ok({ engines: [], files: 0, violations: [] });

    const scan = await this.catalog.scan();
    const canon = new Map(
      scan.rules.flatMap((r) => (r.rule.implementation ? [[r.rule.implementation, r.rule.id]] : [])),
    );
    // Only engines the canon binds rules to: a repo that has a tsconfig but no tsc rules is not typechecked here.
    const used = this.engines.filter((e) =>
      [...canon.keys()].some((k) => parseImplementation(k).engine === e.engine),
    );
    const violations: RuleViolation[] = [];
    for (const engine of used) {
      const diagnostics = await engine.check(files);
      if (diagnostics.isErr()) return err(diagnostics.error);
      // Hints and infos (e.g. pattern detection rules) are not violations.
      for (const d of diagnostics.value.filter((x) => x.severity !== "info")) {
        const canonRuleId = d.toolRuleId ? canon.get(`${engine.engine}:${d.toolRuleId}`) : undefined;
        violations.push({ ...d, engine: engine.engine, ...(canonRuleId ? { canonRuleId } : {}) });
      }
    }
    violations.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
    return ok({ engines: used.map((e) => e.engine), files: files?.length ?? "all", violations });
  }
}

function invalidCanon(scan: RuleCatalogScan): MetatorError {
  return new MetatorError("INVALID_CONFIG", `${scan.problems.length} invalid rule set(s)`, {
    hint: "Run `metator rules lint` for details.",
    details: { problems: scan.problems.map((p) => ({ source: p.source, ...p.error.toJSON() })) },
  });
}
