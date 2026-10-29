import {
  type ArchitectureInput,
  type ArchitectureReport,
  ArchitectureReportDocument,
  analyzeArchitecture,
  type ExternalImport,
  manifestOf,
  type PackageManifest,
  type ResolvedImport,
} from "../domain/architecture.ts";
import {
  type ArchitectureBaseline,
  ArchitectureBaselineDocument,
  type ArchitectureComparison,
  architectureSarif,
  baselineOf,
  compareArchitecture,
  proposePolicy,
  tightenBaseline,
} from "../domain/architecture-check.ts";
import { checkMoves, type Move, type MoveEffect, simulateMoves } from "../domain/architecture-moves.ts";
import {
  type ArchitecturePolicy,
  ArchitecturePolicyDocument,
  ArchitecturePolicySchema,
  EMPTY_POLICY,
  lintPolicy,
} from "../domain/architecture-policy.ts";
import { renderArchitectureHtml, renderArchitectureMarkdown } from "../domain/architecture-render.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { stylePackages } from "../domain/style-imports.ts";
import {
  parseJsonDocument,
  parseYamlDocument,
  renderYamlDocument,
  serializeJsonDocument,
} from "../domain/versioned.ts";
import type {
  ChangeHistory,
  Clock,
  FileSystem,
  ImportAnalyzer,
  ManifestReader,
  ReadonlyFileSystem,
  RevisionReader,
  ToolBoundariesReader,
  Vcs,
} from "../ports/index.ts";
import type { BuildImportGraph } from "./import-graph.ts";
import type { FindOwners } from "./owners.ts";
import type { MetatorPaths } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";
import type { SymbolQueries } from "./symbols.ts";

export interface LoadedPolicy {
  readonly policy: ArchitecturePolicy;
  /** The file it came from, or null for the defaults. */
  readonly source: string | null;
}

/** `metator/architecture.yml`; no file means the defaults (no layers or rules). */
export class ArchitecturePolicyCatalog {
  constructor(
    private readonly fs: ReadonlyFileSystem,
    private readonly file: string,
  ) {}

  get source(): string {
    return this.file;
  }

  async load(): Promise<Result<LoadedPolicy, MetatorError>> {
    const text = await this.fs.read(this.file);
    if (text.isErr()) return ok({ policy: EMPTY_POLICY, source: null });
    const policy = parseYamlDocument(text.value, this.file).andThen((raw) =>
      ArchitecturePolicyDocument.parse(raw, this.file),
    );
    if (policy.isErr()) return err(policy.error);
    const problems = lintPolicy(policy.value);
    if (problems.length > 0)
      return err(
        new MetatorError("INVALID_CONFIG", `${this.file}: ${problems[0]}`, {
          hint: "Every layer a package rule names must be listed in layers, once.",
          details: { problems },
        }),
      );
    return ok({ policy: policy.value, source: this.file });
  }
}

/** Everything the analysis reads, gathered once (the check and simulations reuse it). */
export class ArchitectureFacts {
  constructor(
    private readonly graph: Pick<BuildImportGraph, "execute">,
    private readonly manifests: ManifestReader,
    private readonly policies: ArchitecturePolicyCatalog,
    private readonly clock: Clock,
    private readonly extra: {
      readonly symbols?: Pick<SymbolQueries, "resolvedModules">;
      readonly history?: ChangeHistory;
      readonly owners?: Pick<FindOwners, "execute">;
      readonly styles?: Pick<StyleImports, "uses">;
    } = {},
  ) {}

  /** How many commits `arch analyze` reads for what changes together. */
  static readonly HISTORY = 500;

  async gather(): Promise<Result<ArchitectureInput, MetatorError>> {
    const graph = await this.graph.execute();
    if (graph.isErr()) return err(graph.error);
    const manifests = await this.manifests.manifests();
    if (manifests.isErr()) return err(manifests.error);
    const policy = await this.policies.load();
    if (policy.isErr()) return err(policy.error);
    const modules = this.extra.symbols ? await this.extra.symbols.resolvedModules() : undefined;
    if (modules?.isErr()) return err(modules.error);
    const history = this.extra.history
      ? await this.extra.history.commits(ArchitectureFacts.HISTORY)
      : undefined;
    if (history?.isErr()) return err(history.error);
    let owners: Map<string, readonly string[]> | undefined;
    if (this.extra.owners) {
      const pkgs = manifests.value.packages;
      const found = await this.extra.owners.execute({
        paths: pkgs.map((m) => (m.dir === "." ? "package.json" : `${m.dir}/package.json`)),
      });
      if (found.isErr()) return err(found.error);
      // No CODEOWNERS file: nothing to say about teams.
      if (found.value.source !== undefined)
        owners = new Map(pkgs.map((m, i) => [m.name, found.value.owners[i]?.owners ?? []]));
    }
    const styles = this.extra.styles ? await this.extra.styles.uses() : ok([]);
    if (styles.isErr()) return err(styles.error);
    return ok({
      files: graph.value.files,
      imports: graph.value.imports,
      externals: [...graph.value.externalUses, ...styles.value],
      unresolved: graph.value.unresolved,
      manifests: manifests.value,
      policy: policy.value.policy,
      policySource: policy.value.source,
      today: this.clock.now().toISOString().slice(0, 10),
      ...(modules?.isOk() ? { modules: modules.value } : {}),
      ...(history?.isOk() ? { history: history.value } : {}),
      ...(owners ? { owners } : {}),
    });
  }
}

/** Packages the repository's stylesheets import, as build-time uses of their files (`stylePackages`). */
export class StyleImports {
  static readonly EXTENSIONS = [".css", ".scss", ".sass", ".less", ".pcss"];

  constructor(
    private readonly sources: Pick<SourceFiles, "list">,
    private readonly fs: Pick<ReadonlyFileSystem, "read">,
  ) {}

  async uses(): Promise<
    Result<{ readonly from: string; readonly name: string; readonly typeOnly: boolean }[], MetatorError>
  > {
    const files = await this.sources.list(StyleImports.EXTENSIONS);
    if (files.isErr()) return err(files.error);
    const out: { from: string; name: string; typeOnly: boolean }[] = [];
    for (const from of files.value) {
      const text = await this.fs.read(from);
      if (text.isErr()) continue; // deleted between listing and reading
      // Stylesheets are compiled at build time: a use, never a runtime import.
      for (const name of stylePackages(text.value)) out.push({ from, name, typeOnly: true });
    }
    return ok(out);
  }
}

export interface AnalyzedArchitecture {
  readonly report: ArchitectureReport;
  /** Where the report was written: `report.json`, `report.md` and `report.html`. */
  readonly files: { readonly json: string; readonly markdown: string; readonly html: string };
}

/** `arch analyze` (H1): the report, written as JSON for tools and Markdown for people. */
export class AnalyzeArchitecture {
  constructor(
    private readonly facts: Pick<ArchitectureFacts, "gather">,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async execute(): Promise<Result<AnalyzedArchitecture, MetatorError>> {
    const input = await this.facts.gather();
    if (input.isErr()) return err(input.error);
    const report = analyzeArchitecture(input.value);
    const files = {
      json: `${this.paths.arch}/report.json`,
      markdown: `${this.paths.arch}/report.md`,
      html: `${this.paths.arch}/report.html`,
    };
    const json = await this.fs.write(
      files.json,
      serializeJsonDocument(ArchitectureReportDocument.stamp(report)),
    );
    if (json.isErr()) return err(json.error);
    const markdown = await this.fs.write(files.markdown, renderArchitectureMarkdown(report));
    if (markdown.isErr()) return err(markdown.error);
    const html = await this.fs.write(files.html, renderArchitectureHtml(report));
    if (html.isErr()) return err(html.error);
    return ok({ report, files });
  }
}

/** `metator/arch-baseline.json`: violations the team accepted for now. */
export class ArchitectureBaselineStore {
  constructor(
    private readonly fs: FileSystem,
    private readonly file: string,
  ) {}

  get source(): string {
    return this.file;
  }

  async load(): Promise<Result<ArchitectureBaseline | undefined, MetatorError>> {
    const text = await this.fs.read(this.file);
    if (text.isErr()) return ok(undefined);
    return parseJsonDocument(text.value, this.file).andThen((raw) =>
      ArchitectureBaselineDocument.parse(raw, this.file),
    );
  }

  async save(baseline: ArchitectureBaseline): Promise<Result<void, MetatorError>> {
    return this.fs.write(this.file, serializeJsonDocument(ArchitectureBaselineDocument.stamp(baseline)));
  }
}

/**
 * The facts at a base revision: only changed files can import differently and only changed
 * manifests can declare differently, so the current facts are patched with those files as they
 * were at the merge base (parsed and resolved like the current tree, as `graph diff` does).
 */
export class BaseArchitectureFacts {
  constructor(
    private readonly vcs: Vcs,
    private readonly history: Pick<RevisionReader, "readAt">,
    private readonly analyzer: ImportAnalyzer,
  ) {}

  async at(current: ArchitectureInput, base: string): Promise<Result<ArchitectureInput, MetatorError>> {
    const changed = await this.vcs.changedFiles(base);
    if (changed.isErr()) return err(changed.error);
    const touched = new Set(changed.value);
    const sources = changed.value.filter((f) => this.analyzer.extensions.some((ext) => f.endsWith(ext)));
    const imports: ResolvedImport[] = current.imports.filter((i) => !touched.has(i.from));
    const externals: ExternalImport[] = current.externals.filter((x) => !touched.has(x.from));
    const files = new Set(current.files);
    const texts = new Map<string, string>();
    for (const file of sources) {
      const text = await this.history.readAt(base, file);
      if (text.isErr()) return err(text.error);
      if (text.value === undefined)
        files.delete(file); // added on the branch
      else texts.set(file, text.value);
    }
    // Files only the base has (deleted or renamed on the branch) are part of the base, and base
    // imports of them resolve to them, not to whatever the current tree has at that path.
    const baseOnly = new Set([...texts.keys()].filter((f) => !current.files.includes(f)));
    for (const f of baseOnly) files.add(f);
    for (const [file, text] of texts) {
      const parsed = this.analyzer.parse(file, text);
      if (parsed.isErr()) continue; // unparsable at the base: nothing to compare against
      for (const imp of parsed.value) {
        const target = this.analyzer.resolve(file, imp.specifier);
        const atBase =
          target.type === "file"
            ? undefined
            : resolveAmong(file, imp.specifier, baseOnly, this.analyzer.extensions);
        if (atBase)
          imports.push({ from: file, to: atBase, specifier: imp.specifier, typeOnly: imp.typeOnly });
        else if (target.type === "file")
          imports.push({ from: file, to: target.path, specifier: imp.specifier, typeOnly: imp.typeOnly });
        else if (target.type === "external")
          externals.push({ from: file, name: target.name, typeOnly: imp.typeOnly });
      }
    }
    const manifestAt = async (
      m: PackageManifest,
    ): Promise<Result<PackageManifest | undefined, MetatorError>> => {
      const file = m.dir === "." ? "package.json" : `${m.dir}/package.json`;
      if (!touched.has(file)) return ok(m);
      const text = await this.history.readAt(base, file);
      if (text.isErr()) return err(text.error);
      if (text.value === undefined) return ok(undefined); // the package is new on the branch
      const json = parseJsonDocument(text.value, file);
      return ok(
        json.isOk()
          ? manifestOf(m.dir, json.value, {
              tags: m.tags,
              ...(m.projectType ? { projectType: m.projectType } : {}),
            })
          : m,
      );
    };
    const packages: PackageManifest[] = [];
    for (const m of current.manifests.packages) {
      const at = await manifestAt(m);
      if (at.isErr()) return err(at.error);
      if (at.value) packages.push(at.value);
    }
    const root = current.manifests.root ? await manifestAt(current.manifests.root) : ok(undefined);
    if (root.isErr()) return err(root.error);
    return ok({
      ...current,
      files: [...files],
      imports,
      externals,
      manifests: { ...(root.value ? { root: root.value } : {}), packages },
    });
  }
}

export interface ArchitectureCheck extends ArchitectureComparison {
  readonly base: string | null;
  readonly baseline: string | null;
  readonly summary: ArchitectureReport["summary"];
  /** Where the SARIF log was written, when asked for. */
  readonly sarif?: string;
}

/**
 * `arch check` (H2): the ratchet. A violation fails the check only when the change adds it:
 * not at the base (`--base`), not in the baseline, not covered by an exception.
 */
export class CheckArchitecture {
  constructor(
    private readonly facts: Pick<ArchitectureFacts, "gather">,
    private readonly baseFacts: Pick<BaseArchitectureFacts, "at">,
    private readonly baselines: ArchitectureBaselineStore,
    private readonly fs: FileSystem,
  ) {}

  async execute(input: {
    readonly base?: string;
    readonly strict?: boolean;
    readonly sarif?: string;
  }): Promise<Result<ArchitectureCheck, MetatorError>> {
    const current = await this.facts.gather();
    if (current.isErr()) return err(current.error);
    const report = analyzeArchitecture(current.value);
    let base: ArchitectureReport | undefined;
    if (input.base !== undefined) {
      const at = await this.baseFacts.at(current.value, input.base);
      if (at.isErr()) return err(at.error);
      base = analyzeArchitecture(at.value);
    }
    const baseline = await this.baselines.load();
    if (baseline.isErr()) return err(baseline.error);
    const comparison = compareArchitecture({
      current: report,
      ...(base ? { base } : {}),
      ...(baseline.value ? { baseline: baseline.value } : {}),
      ...(input.strict ? { strict: true } : {}),
    });
    if (input.sarif !== undefined) {
      const saved = await this.fs.write(
        input.sarif,
        // SARIF is not a MetatorAI document; it only shares the JSON serializer.
        serializeJsonDocument(architectureSarif(comparison.added, report.policy)),
      );
      if (saved.isErr()) return err(saved.error);
    }
    return ok({
      base: input.base ?? null,
      baseline: baseline.value ? this.baselines.source : null,
      summary: report.summary,
      ...comparison,
      ...(input.sarif !== undefined ? { sarif: input.sarif } : {}),
    });
  }
}

/** `arch baseline`: accept the current violations, or (`--tighten`) drop only the fixed ones. */
export class RecordArchitectureBaseline {
  constructor(
    private readonly facts: Pick<ArchitectureFacts, "gather">,
    private readonly baselines: ArchitectureBaselineStore,
  ) {}

  async execute(input: {
    readonly tighten?: boolean;
  }): Promise<
    Result<{ readonly file: string; readonly violations: number; readonly dropped: number }, MetatorError>
  > {
    const facts = await this.facts.gather();
    if (facts.isErr()) return err(facts.error);
    const report = analyzeArchitecture(facts.value);
    const previous = await this.baselines.load();
    if (previous.isErr()) return err(previous.error);
    if (input.tighten && !previous.value)
      return err(
        MetatorError.usage(`${this.baselines.source} does not exist`, "Run `metator arch baseline` first."),
      );
    const next =
      input.tighten && previous.value ? tightenBaseline(previous.value, report) : baselineOf(report);
    const saved = await this.baselines.save(next);
    if (saved.isErr()) return err(saved.error);
    const before = previous.value?.violations.length ?? 0;
    return ok({
      file: this.baselines.source,
      violations: next.violations.length,
      dropped: input.tighten ? before - next.violations.length : 0,
    });
  }
}

/** `arch init`: proposes `metator/architecture.yml` from the repository; never overwrites. */
export class InitArchitecturePolicy {
  constructor(
    private readonly facts: Pick<ArchitectureFacts, "gather">,
    private readonly tools: ToolBoundariesReader,
    private readonly fs: FileSystem,
    private readonly file: string,
  ) {}

  async execute(): Promise<
    Result<
      { readonly file: string; readonly policy: Record<string, unknown>; readonly notes: readonly string[] },
      MetatorError
    >
  > {
    if ((await this.fs.read(this.file)).isOk())
      return err(MetatorError.usage(`${this.file} already exists`, "Edit it; `arch init` never overwrites."));
    const facts = await this.facts.gather();
    if (facts.isErr()) return err(facts.error);
    const tools = await this.tools.read();
    if (tools.isErr()) return err(tools.error);
    const proposal = proposePolicy(analyzeArchitecture(facts.value), tools.value);
    const doc = ArchitecturePolicyDocument.stamp(ArchitecturePolicySchema.parse(proposal.body));
    const text = renderYamlDocument(
      { kind: doc.kind, schemaVersion: doc.schemaVersion, ...proposal.body },
      `How packages may depend on each other (metator arch). ${proposal.notes.join(" ")}`,
    );
    const saved = await this.fs.write(this.file, text);
    if (saved.isErr()) return err(saved.error);
    return ok({ file: this.file, policy: proposal.body, notes: proposal.notes });
  }
}

export interface SimulatedArchitecture {
  readonly moves: readonly Move[];
  readonly effect: MoveEffect;
  /** Cycles left after the moves. */
  readonly cycles: ArchitectureReport["cycles"];
}

/** `arch simulate` (H4): what moves would fix and break, computed on the facts, no file touched. */
export class SimulateArchitecture {
  constructor(private readonly facts: Pick<ArchitectureFacts, "gather">) {}

  async execute(input: {
    readonly moves: readonly Move[];
  }): Promise<Result<SimulatedArchitecture, MetatorError>> {
    const facts = await this.facts.gather();
    if (facts.isErr()) return err(facts.error);
    const problems = checkMoves(facts.value, input.moves);
    if (problems.length > 0)
      return err(
        MetatorError.usage(
          problems[0] as string,
          "Name packages as `arch analyze` lists them; files are repo paths or globs.",
        ),
      );
    const simulated = simulateMoves(facts.value, input.moves);
    return ok({ moves: input.moves, effect: simulated.effect, cycles: simulated.report.cycles });
  }
}

/** A relative specifier resolved among `files` (with an extension, `.js` written for `.ts`, or `index`). */
export function resolveAmong(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
  extensions: readonly string[],
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  const path = parts.join("/");
  const stem = path.replace(/\.[cm]?jsx?$/, "");
  const candidates = [
    path,
    ...extensions.map((e) => `${stem}${e}`),
    ...extensions.map((e) => `${path}${e}`),
    ...extensions.map((e) => `${path}/index${e}`),
  ];
  return candidates.find((c) => files.has(c));
}
