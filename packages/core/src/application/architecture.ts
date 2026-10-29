import {
  type ArchitectureInput,
  type ArchitectureReport,
  ArchitectureReportDocument,
  analyzeArchitecture,
} from "../domain/architecture.ts";
import {
  type ArchitecturePolicy,
  ArchitecturePolicyDocument,
  EMPTY_POLICY,
  lintPolicy,
} from "../domain/architecture-policy.ts";
import { renderArchitectureMarkdown } from "../domain/architecture-render.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseYamlDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem, ManifestReader, ReadonlyFileSystem } from "../ports/index.ts";
import type { BuildImportGraph } from "./import-graph.ts";
import type { MetatorPaths } from "./paths.ts";

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
  ) {}

  async gather(): Promise<Result<ArchitectureInput, MetatorError>> {
    const graph = await this.graph.execute();
    if (graph.isErr()) return err(graph.error);
    const manifests = await this.manifests.manifests();
    if (manifests.isErr()) return err(manifests.error);
    const policy = await this.policies.load();
    if (policy.isErr()) return err(policy.error);
    return ok({
      files: graph.value.files,
      imports: graph.value.imports,
      externals: graph.value.externalUses,
      unresolved: graph.value.unresolved,
      manifests: manifests.value,
      policy: policy.value.policy,
      policySource: policy.value.source,
      today: this.clock.now().toISOString().slice(0, 10),
    });
  }
}

export interface AnalyzedArchitecture {
  readonly report: ArchitectureReport;
  /** Where the report was written: `report.json` and `report.md`. */
  readonly files: { readonly json: string; readonly markdown: string };
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
    const files = { json: `${this.paths.arch}/report.json`, markdown: `${this.paths.arch}/report.md` };
    const json = await this.fs.write(
      files.json,
      serializeJsonDocument(ArchitectureReportDocument.stamp(report)),
    );
    if (json.isErr()) return err(json.error);
    const markdown = await this.fs.write(files.markdown, renderArchitectureMarkdown(report));
    if (markdown.isErr()) return err(markdown.error);
    return ok({ report, files });
  }
}
