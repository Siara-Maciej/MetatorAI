import slugify from "@sindresorhus/slugify";
import { type ArchModule, analyzeModules, type ModulesReport } from "../domain/architecture-modules.ts";
import type { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import { packageOf } from "../domain/import-index.ts";
import { cardSkeleton, renderCard, splitCard } from "../domain/module-card.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseConsumes, type SystemMap } from "../domain/system-map.ts";
import { readFrontMatter } from "../domain/versioned.ts";
import type { FileSystem, WorkspacePackage } from "../ports/index.ts";
import type { ArchitecturePolicyCatalog } from "./architecture.ts";
import type { BuildImportGraph, ImportGraphReport } from "./import-graph.ts";
import type { FindOwners } from "./owners.ts";
import type { MetatorPaths } from "./paths.ts";
import type { PatternCatalog } from "./patterns.ts";
import type { MapFile } from "./system-sources.ts";

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
 * and the cataloged patterns whose exemplar lives in the package (ADR-0045). A package that is an
 * application of this repository's system map gets its contracts too (F7.5). Curated text is kept.
 */
export class BuildModuleCards {
  constructor(
    private readonly graph: Pick<BuildImportGraph, "execute">,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
    private readonly testGlobs: readonly string[],
    private readonly owners: Pick<FindOwners, "execute">,
    private readonly patterns: Pick<PatternCatalog, "scan">,
    private readonly system?: Pick<MapFile, "load">,
    /** The architecture policy: its `modules` get a card each, as packages do (ADR-0074). */
    private readonly architecture?: Pick<ArchitecturePolicyCatalog, "load">,
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

    const map = this.system ? await this.system.load() : ok(undefined);
    if (map.isErr()) return err(map.error);

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
        ...(map.value ? { application: applicationLine(map.value, pkg.dir) } : {}),
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

    // Modules inside a package (a modular monolith's `src/module/*`): a card per module.
    const policy = this.architecture ? await this.architecture.load() : ok(undefined);
    if (policy.isErr()) return err(policy.error);
    const modulesPolicy = policy.value?.policy.modules;
    if (modulesPolicy) {
      const isTest = (f: string) => matchesAny(f, this.testGlobs);
      const inner = analyzeModules({
        policy: modulesPolicy,
        files: r.files,
        imports: r.imports,
        isTest,
        packageOf: (dir) => packageOf(`${dir}/x`, r.packages)?.name ?? "(root)",
      });
      const dirs = inner.modules.map((m) => m.dir);
      const owned = await this.owners.execute({ paths: dirs.map((d) => `${d}/index.ts`) });
      if (owned.isErr()) return err(owned.error);
      for (const [i, m] of inner.modules.entries()) {
        const pkg = packageOf(`${m.dir}/x`, r.packages);
        const name = pkg && pkg.name !== "(root)" && !m.name.includes("/") ? `${pkg.name}/${m.name}` : m.name;
        const file = cardFile(this.paths.cards, name);
        expected.add(file);
        const generated = renderModule(m, inner, r, isTest, {
          owners: owned.value.owners[i]?.owners ?? [],
          codeowners: owned.value.source !== undefined,
          patterns: exemplars.filter((e) => e.file.startsWith(`${m.dir}/`)).map((e) => e.id),
          package: pkg?.name ?? "(root)",
        });
        const current = await this.fs.read(file);
        let next: string;
        if (current.isErr()) {
          next = renderCard({ package: name, dir: m.dir, generated, ...cardSkeleton(name) });
        } else {
          const parts = splitCard(current.value, file);
          if (parts.isErr()) {
            invalid.push({ file, message: parts.error.message });
            continue;
          }
          next = renderCard({ ...parts.value, package: name, dir: m.dir, generated });
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
    readonly application?: string | undefined;
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
    ...(extra.application ? [extra.application] : []),
    "",
  ];
  return lines.join("\n");
}

/** The generated block of a module's card: the same structural facts as a package's, between modules. */
function renderModule(
  m: ArchModule,
  inner: ModulesReport,
  r: ImportGraphReport,
  isTest: (file: string) => boolean,
  extra: {
    readonly owners: readonly string[];
    readonly codeowners: boolean;
    readonly patterns: readonly string[];
    readonly package: string;
  },
): string {
  const inModule = (f: string) => f.startsWith(`${m.dir}/`);
  const surface = new Set<string>();
  for (const i of r.imports)
    if (
      inModule(i.to) &&
      !inModule(i.from) &&
      !isTest(i.from) &&
      inner.modules.some((o) => i.from.startsWith(`${o.dir}/`))
    )
      surface.add(i.to);
  const pastPublic = inner.edges.filter((e) => e.to === m.name && e.internal > 0).map((e) => e.from);
  const names = (values: Iterable<string>) => {
    const sorted = [...new Set(values)].sort();
    return sorted.length === 0 ? "none" : sorted.map((v) => `\`${v}\``).join(", ");
  };
  const twoWay = inner.twoWay.filter((p) => p.includes(m.name)).map((p) => (p[0] === m.name ? p[1] : p[0]));
  const lines = [
    "",
    "<!-- Generated by `metator cards build` from the import graph. Edit the sections below, not this block. -->",
    `- Directory: \`${m.dir}\` (a module of \`${extra.package}\`)`,
    `- Depends on modules: ${names(m.dependsOn)}`,
    `- Used by modules: ${names(m.dependents)}`,
    `- Imports each other with: ${names(twoWay)}`,
    `- Imported by other modules: ${names(surface)}`,
    ...(inner.public
      ? [`- Imported past its public part (${inner.public.join(", ")}) by: ${names(pastPublic)}`]
      : []),
    `- Owners: ${extra.codeowners ? names(extra.owners) : "none (no CODEOWNERS)"}`,
    `- Patterns with their exemplar here: ${names(extra.patterns)}`,
    "",
  ];
  return lines.join("\n");
}

/** The application of the map whose code is this package's directory, as a card line. */
export function applicationLine(map: SystemMap, dir: string): string | undefined {
  const app = map.applications.find((a) => !("repo" in a.source) && a.source.path === dir);
  if (!app) return undefined;
  const tick = (values: readonly string[]) =>
    values.length === 0 ? "none" : values.map((v) => `\`${v}\``).join(", ");
  const provides = map.contracts
    .filter((c) => c.owner === app.id)
    .map((c) => {
      const users = map.applications.filter((a) =>
        a.consumes.some((x) => parseConsumes(x).contract === c.id),
      );
      return `\`${c.id}\`${users.length > 0 ? ` (consumed by ${tick(users.map((u) => u.id))})` : ""}`;
    });
  return `- System application: \`${app.id}\` (${app.kind}); provides ${provides.length > 0 ? provides.join(", ") : "none"}; consumes ${tick(app.consumes)}`;
}
