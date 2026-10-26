import { MetatorError } from "../domain/errors.ts";
import { packageOf } from "../domain/import-index.ts";
import { type Pattern, PatternDocument, PatternIndexDocument, pathAffinity } from "../domain/pattern.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseImplementation } from "../domain/rule.ts";
import { parseYamlDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { FileSystem, ReadonlyFileSystem, RuleEngine, WorkspaceReader } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";
import type { RuleCatalog } from "./rules.ts";

export interface PatternEntry {
  readonly pattern: Pattern;
  readonly source: string;
}

/** The pattern catalog: every `Pattern` YAML document under `paths.patterns`. */
export class PatternCatalog {
  constructor(
    private readonly fs: ReadonlyFileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async scan(): Promise<{
    readonly patterns: readonly PatternEntry[];
    readonly problems: readonly { readonly source: string; readonly error: MetatorError }[];
  }> {
    const files = await this.fs.glob([`${this.paths.patterns}/*.yml`, `${this.paths.patterns}/*.yaml`]);
    const patterns: PatternEntry[] = [];
    const problems: { source: string; error: MetatorError }[] = [];
    for (const source of [...files].sort()) {
      const parsed = (await this.fs.read(source))
        .andThen((t) => parseYamlDocument(t, source))
        .andThen((raw) => PatternDocument.parse(raw, source));
      if (parsed.isOk()) patterns.push({ pattern: parsed.value, source });
      else problems.push({ source, error: parsed.error });
    }
    return { patterns, problems };
  }
}

export interface Occurrence {
  readonly file: string;
  readonly line: number;
}

export interface ScannedPattern {
  readonly id: string;
  readonly title: string;
  readonly intent: string;
  readonly exemplar: string;
  readonly occurrences: readonly Occurrence[];
  readonly byPackage: Readonly<Record<string, number>>;
  /** Legacy files the detection still finds (never offered as examples). */
  readonly legacy: readonly string[];
}

export interface PatternProblem {
  readonly source: string;
  readonly pattern?: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface PatternScan {
  readonly patterns: readonly ScannedPattern[];
  readonly problems: readonly PatternProblem[];
}

/**
 * Finds every occurrence of every cataloged pattern with its detection rule, writes the
 * derived pattern index, and checks the catalog: exemplar is a real occurrence, enough
 * occurrences, detection rule exists (with a test), referenced canon rules exist.
 */
export class ScanPatterns {
  constructor(
    private readonly catalog: PatternCatalog,
    private readonly rules: RuleCatalog,
    private readonly engines: readonly RuleEngine[],
    private readonly workspace: WorkspaceReader,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async execute(): Promise<Result<PatternScan, MetatorError>> {
    const scan = await this.catalog.scan();
    const problems: PatternProblem[] = scan.problems.map((p) => ({
      source: p.source,
      severity: "error",
      message: p.error.message,
    }));
    const packages = await this.workspace.packages();
    if (packages.isErr()) return err(packages.error);
    const canon = new Set((await this.rules.scan()).rules.map((r) => r.rule.id));

    // Run each engine the catalog needs once, over the whole repository.
    const hits = new Map<string, Occurrence[]>();
    const engineRules = new Map<string, Map<string, boolean>>();
    for (const engine of this.engines) {
      if (!scan.patterns.some((p) => parseImplementation(p.pattern.detection).engine === engine.engine))
        continue;
      const known = await engine.rules();
      if (known.isErr()) return err(known.error);
      engineRules.set(engine.engine, new Map(known.value.map((r) => [r.id, r.hasTest])));
      const diagnostics = await engine.check();
      if (diagnostics.isErr()) return err(diagnostics.error);
      for (const d of diagnostics.value) {
        if (!d.toolRuleId) continue;
        const key = `${engine.engine}:${d.toolRuleId}`;
        const list = hits.get(key) ?? [];
        if (!list.some((o) => o.file === d.file)) list.push({ file: d.file, line: d.line ?? 1 });
        hits.set(key, list);
      }
    }

    const seen = new Set<string>();
    const patterns: ScannedPattern[] = [];
    for (const { pattern: p, source } of scan.patterns) {
      const problem = (severity: "error" | "warning", message: string) =>
        problems.push({ source, pattern: p.id, severity, message });
      if (seen.has(p.id)) problem("error", `duplicate pattern id ${p.id}`);
      seen.add(p.id);

      const { engine, ruleId } = parseImplementation(p.detection);
      const known = engineRules.get(engine);
      if (!known) problem("error", `no adapter for engine "${engine}"`);
      else if (!known.has(ruleId)) problem("error", `detection rule ${p.detection} does not exist`);
      else if (!known.get(ruleId)) problem("warning", `detection rule ${p.detection} has no test`);
      for (const id of p.rules) if (!canon.has(id)) problem("error", `references unknown rule ${id}`);

      const legacyPaths = new Set(p.legacy.map((l) => l.path));
      for (const l of p.legacy) {
        if (!(await this.fs.exists(l.path))) problem("warning", `legacy file not found: ${l.path}`);
      }
      const all = [...(hits.get(p.detection) ?? [])].sort((a, b) => a.file.localeCompare(b.file));
      const occurrences = all.filter((o) => !legacyPaths.has(o.file));
      if (occurrences.length < p.minOccurrences) {
        problem("error", `${occurrences.length} occurrence(s), expected at least ${p.minOccurrences}`);
      }
      if (legacyPaths.has(p.exemplar)) problem("error", `exemplar ${p.exemplar} is marked legacy`);
      else if (!occurrences.some((o) => o.file === p.exemplar)) {
        problem("error", `exemplar ${p.exemplar} is not an occurrence of ${p.detection}`);
      }

      const byPackage: Record<string, number> = {};
      for (const o of occurrences) {
        const name = packageOf(o.file, packages.value)?.name ?? "(root)";
        byPackage[name] = (byPackage[name] ?? 0) + 1;
      }
      patterns.push({
        id: p.id,
        title: p.title,
        intent: p.intent,
        exemplar: p.exemplar,
        occurrences,
        byPackage,
        legacy: all.filter((o) => legacyPaths.has(o.file)).map((o) => o.file),
      });
    }

    const index = PatternIndexDocument.stamp({
      patterns: patterns.map((p) => ({
        id: p.id,
        occurrences: [...p.occurrences],
        byPackage: { ...p.byPackage },
      })),
    });
    const saved = await this.fs.write(`${this.paths.index}/patterns.json`, serializeJsonDocument(index));
    if (saved.isErr()) return err(saved.error);
    return ok({ patterns, problems });
  }
}

export interface SimilarMatch {
  readonly pattern: string;
  readonly title: string;
  readonly file: string;
  readonly line: number;
  readonly exemplar: boolean;
  readonly score: number;
  readonly reasons: readonly string[];
}

/** "Show me how we already do this": ranked occurrences for a planned file or a description. */
export class FindSimilar {
  constructor(private readonly scan: ScanPatterns) {}

  async execute(input: {
    readonly target?: string;
    readonly query?: string;
    readonly top: number;
  }): Promise<Result<readonly SimilarMatch[], MetatorError>> {
    if (!input.target && !input.query) {
      return err(
        MetatorError.usage(
          "Give a planned file path or a description",
          "e.g. `metator similar --file packages/core/src/application/x.ts`",
        ),
      );
    }
    const scanned = await this.scan.execute();
    if (scanned.isErr()) return err(scanned.error);
    const words = tokens(input.query ?? "");
    const matches: SimilarMatch[] = [];
    for (const p of scanned.value.patterns) {
      const text = tokens(`${p.id} ${p.title} ${p.intent}`);
      const overlap = [...words].filter((w) => text.has(w));
      for (const o of p.occurrences) {
        const reasons: string[] = [];
        let score = 0;
        if (overlap.length > 0) {
          score += overlap.length * 2;
          reasons.push(`pattern matches "${overlap.join(" ")}"`);
        }
        if (input.target) {
          const affinity = pathAffinity(o.file, input.target);
          score += affinity.score;
          reasons.push(...affinity.reasons);
        }
        if (score === 0) continue;
        const exemplar = o.file === p.exemplar;
        if (exemplar) {
          score += 1;
          reasons.push("the pattern's exemplar");
        }
        matches.push({ pattern: p.id, title: p.title, file: o.file, line: o.line, exemplar, score, reasons });
      }
    }
    matches.sort(
      (a, b) => b.score - a.score || Number(b.exemplar) - Number(a.exemplar) || a.file.localeCompare(b.file),
    );
    return ok(matches.slice(0, input.top));
  }
}

const STOP = new Set(["a", "an", "the", "to", "of", "in", "for", "and", "or", "with", "new", "add"]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => w.replace(/s$/, "")),
  );
}
