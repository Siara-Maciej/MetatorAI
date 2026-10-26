import slugify from "@sindresorhus/slugify";
import type { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import { packageOf } from "../domain/import-index.ts";
import { cardSkeleton, renderCard, splitCard } from "../domain/module-card.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { readFrontMatter } from "../domain/versioned.ts";
import type { FileSystem, WorkspacePackage } from "../ports/index.ts";
import type { BuildImportGraph, ImportGraphReport } from "./import-graph.ts";
import type { FindOwners } from "./owners.ts";
import type { MetatorPaths } from "./paths.ts";
import type { PatternCatalog } from "./patterns.ts";

export interface CardsReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  /** In check mode: cards whose generated block differs from the index, or that are missing. */
  readonly stale: readonly string[];
  /** Cards of packages that no longer exist. */
  readonly orphaned: readonly string[];
  /** Cards that cannot be updated safely (broken header or markers); never overwritten. */
  readonly invalid: readonly { readonly file: string; readonly message: string }[];
}

/** `@acme/billing` → `acme-billing`, `(root)` → `root`. */
export function cardFile(dir: string, pkg: string): string {
  return `${dir}/${slugify(pkg.replace(/^@/, "")) || "root"}.card.md`;
}

/**
 * Generated part of module cards from the import graph: dependencies, dependents, files other
 * packages import (the effective public surface), third-party packages; owners from CODEOWNERS
 * and the cataloged patterns whose exemplar lives in the package (ADR-0045). Curated text is kept.
 */
export class BuildModuleCards {
  constructor(
    private readonly graph: Pick<BuildImportGraph, "execute">,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
    private readonly testGlobs: readonly string[],
    private readonly owners: Pick<FindOwners, "execute">,
    private readonly patterns: Pick<PatternCatalog, "scan">,
  ) {}

  async execute(input: { readonly check: boolean }): Promise<Result<CardsReport, MetatorError>> {
    const report = await this.graph.execute();
    if (report.isErr()) return err(report.error);
    const r = report.value;
    // A file at the package root stands for the package: CODEOWNERS decides per path.
    const probe = (dir: string) => (dir === "" || dir === "." ? "package.json" : `${dir}/package.json`);
    const owned = await this.owners.execute({ paths: r.packages.map((p) => probe(p.dir)) });
    if (owned.isErr()) return err(owned.error);
    const exemplars = (await this.patterns.scan()).patterns.map((p) => ({
      id: p.pattern.id,
      file: p.pattern.exemplar,
    }));

    const written: string[] = [];
    const unchanged: string[] = [];
    const stale: string[] = [];
    const invalid: { file: string; message: string }[] = [];
    const expected = new Set<string>();

    for (const [i, pkg] of r.packages.entries()) {
      const file = cardFile(this.paths.cards, pkg.name);
      expected.add(file);
      const extra = {
        owners: owned.value.owners[i]?.owners ?? [],
        codeowners: owned.value.source !== undefined,
        patterns: exemplars.filter((e) => packageOf(e.file, r.packages)?.dir === pkg.dir).map((e) => e.id),
      };
      const generated = renderGenerated(pkg, r, this.testGlobs, extra);
      const current = await this.fs.read(file);
      let next: string;
      if (current.isErr()) {
        next = renderCard({ package: pkg.name, dir: pkg.dir, generated, ...cardSkeleton(pkg.name) });
      } else {
        const parts = splitCard(current.value, file);
        if (parts.isErr()) {
          invalid.push({ file, message: parts.error.message });
          continue;
        }
        next = renderCard({ ...parts.value, package: pkg.name, dir: pkg.dir, generated });
        if (next === current.value) {
          unchanged.push(file);
          continue;
        }
      }
      if (input.check) {
        stale.push(file);
        continue;
      }
      const saved = await this.fs.write(file, next);
      if (saved.isErr()) return err(saved.error);
      written.push(file);
    }

    const orphaned: string[] = [];
    for (const file of await this.fs.glob([`${this.paths.cards}/*.card.md`])) {
      if (expected.has(file)) continue;
      const text = await this.fs.read(file);
      const header = text.andThen((t) => readFrontMatter(t, file));
      if (header.isOk() && (header.value as { kind?: unknown } | null)?.kind === "ModuleCard")
        orphaned.push(file);
    }
    return ok({ written, unchanged, stale, orphaned: orphaned.sort(), invalid });
  }
}

function renderGenerated(
  pkg: WorkspacePackage,
  r: ImportGraphReport,
  testGlobs: readonly string[],
  extra: {
    readonly owners: readonly string[];
    readonly codeowners: boolean;
    readonly patterns: readonly string[];
  },
): string {
  const owner = (file: string) => packageOf(file, r.packages);
  const mine = (file: string) => owner(file)?.dir === pkg.dir;

  // Production view: edges from test files are listed separately, never as dependencies.
  const isTest = (file: string) => matchesAny(file, testGlobs);
  const dependsOn = new Set<string>();
  const testDependsOn = new Set<string>();
  const usedBy = new Set<string>();
  const surface = new Set<string>();
  for (const e of r.edges) {
    if (e.kind !== "cross-package") continue;
    const from = owner(e.from)?.name ?? "(root)";
    const to = owner(e.to)?.name ?? "(root)";
    if (mine(e.from)) (isTest(e.from) ? testDependsOn : dependsOn).add(to);
    if (mine(e.to) && !isTest(e.from)) {
      usedBy.add(from);
      surface.add(e.to);
    }
  }
  const thirdParty = [
    ...new Set(
      r.externalUses
        .filter((u) => mine(u.from) && !isTest(u.from) && !/^(node|bun):/.test(u.name))
        .map((u) => u.name),
    ),
  ].sort();

  // Only structural facts: they change when the architecture changes, not with every new file.
  const names = (values: Iterable<string>) => {
    const sorted = [...new Set(values)].sort();
    return sorted.length === 0 ? "none" : sorted.map((v) => `\`${v}\``).join(", ");
  };

  const lines = [
    "",
    "<!-- Generated by `metator cards build` from the import graph. Edit the sections below, not this block. -->",
    `- Directory: \`${pkg.dir}\``,
    `- Depends on: ${names(dependsOn)}`,
    `- Test-only dependencies: ${names([...testDependsOn].filter((d) => !dependsOn.has(d)))}`,
    `- Used by: ${names(usedBy)}`,
    `- Imported by other packages: ${names(surface)}`,
    `- Third-party: ${names(thirdParty)}`,
    `- Owners: ${extra.codeowners ? names(extra.owners) : "none (no CODEOWNERS)"}`,
    `- Patterns with their exemplar here: ${names(extra.patterns)}`,
    "",
  ];
  return lines.join("\n");
}
