import { alg, Graph } from "@dagrejs/graphlib";
import { z } from "zod";
import {
  appReach,
  changeCoupling,
  cheapestCut,
  definitionOf,
  depths,
  fileClusters,
  metricsOf,
  overThresholds,
  reachedExports,
} from "./architecture-metrics.ts";
import {
  ARCH_TEST_GLOBS,
  ARCH_TOOLING_GLOBS,
  type ArchitecturePolicy,
  type ArchSeverity,
  brokenTagRules,
  DEFAULT_SEVERITY,
  layerOf,
  matchesPackage,
  tagsOf,
  VIOLATION_KINDS,
  type ViolationKind,
} from "./architecture-policy.ts";
import { matchesAny } from "./glob.ts";
import { packageOf } from "./import-index.ts";
import type { ResolvedModule } from "./symbols.ts";
import { defineDocument } from "./versioned.ts";

/**
 * The architecture of a repository's packages (H1–H4, design/11): the package graph aggregated
 * from the file-level import graph, its cycles, declared against used dependencies, the policy's
 * layers and tag rules, metrics and boundaries. Everything here is computed, never judged: a
 * refactor plan proposes moves, and the same analysis on the moved graph proves them.
 */

/** Files outside every workspace package belong to the repository root. */
export const ROOT_PACKAGE = "(root)";

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
] as const;
export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

/** What `package.json` (and Nx `project.json`, Turborepo `turbo.json`) say about one package. */
export interface PackageManifest {
  readonly name: string;
  /** Repo-relative directory; "." for the repository root. */
  readonly dir: string;
  readonly private: boolean;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  /** `main`, `module`, `exports` or `types`: something other packages load. */
  readonly entry: boolean;
  /** Repo-relative files those fields point to (their public API). */
  readonly entries: readonly string[];
  readonly bin: boolean;
  readonly scripts: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
  readonly projectType?: "application" | "library";
}

export interface ManifestSet {
  readonly root?: PackageManifest;
  readonly packages: readonly PackageManifest[];
}

const record = (value: unknown): Record<string, string> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      )
    : {};

/** A manifest from a parsed `package.json`; anything malformed reads as absent. */
export function manifestOf(
  dir: string,
  json: unknown,
  extra: { readonly tags?: readonly string[]; readonly projectType?: "application" | "library" } = {},
): PackageManifest {
  const pkg = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const has = (key: string) => pkg[key] !== undefined && pkg[key] !== null;
  return {
    name: typeof pkg.name === "string" && pkg.name !== "" ? pkg.name : dir === "." ? ROOT_PACKAGE : dir,
    dir,
    private: pkg.private === true,
    dependencies: record(pkg.dependencies),
    peerDependencies: record(pkg.peerDependencies),
    optionalDependencies: record(pkg.optionalDependencies),
    devDependencies: record(pkg.devDependencies),
    entry: has("main") || has("module") || has("exports") || has("types"),
    entries: entryFiles(dir, [pkg.main, pkg.module, pkg.types, pkg.exports]),
    bin: has("bin"),
    scripts: record(pkg.scripts),
    tags: [...new Set(extra.tags ?? [])].sort(),
    ...(extra.projectType ? { projectType: extra.projectType } : {}),
  };
}

/** Every string leaf of the entry fields, as repo-relative paths. */
function entryFiles(dir: string, values: readonly unknown[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const rel = v.replace(/^\.\//, "");
      if (!rel.startsWith("..") && !rel.includes("*")) out.add(dir === "." ? rel : `${dir}/${rel}`);
    } else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  for (const v of values) walk(v);
  return [...out].sort();
}

/** The field that declares `dependency`, preferring the ones that ship. */
export function declaredIn(
  manifest: PackageManifest | undefined,
  dependency: string,
): DependencyField | undefined {
  return manifest ? DEPENDENCY_FIELDS.find((f) => manifest[f][dependency] !== undefined) : undefined;
}

// ---------------------------------------------------------------------------------------------
// The report document

const Name = z.string().min(1);
const Evidence = z.strictObject({
  file: z.string(),
  to: z.string().optional(),
  specifier: z.string().optional(),
});

const ViolationSchema = z.strictObject({
  /** Stable across runs (`kind:subject`): baselines and exceptions refer to it. */
  id: z.string().min(1),
  kind: z.enum(VIOLATION_KINDS),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  packages: z.array(Name),
  evidence: z.array(Evidence),
  /** Set when a policy exception covers the violation; it then does not count. */
  exception: z.strictObject({ reason: z.string(), owner: z.string(), expires: z.string() }).optional(),
});
export type Violation = z.output<typeof ViolationSchema>;

const MetricsSchema = z.strictObject({
  /** Afferent coupling: workspace packages that depend on this one. */
  ca: z.number().int().nonnegative(),
  /** Efferent coupling: workspace packages this one depends on. */
  ce: z.number().int().nonnegative(),
  /** Ce / (Ca + Ce); 0 is maximally stable. */
  instability: z.number().min(0).max(1),
  /** Share of exported symbols that are types and interfaces. */
  abstractness: z.number().min(0).max(1),
  /** |A + I − 1|: distance from the main sequence. */
  distance: z.number().min(0).max(1),
  /** The longest dependency chain below the package. */
  depth: z.number().int().nonnegative(),
  /** Share of the exported symbols other packages import (null without exports). */
  exportsUsed: z.number().min(0).max(1).nullable(),
});

const PackageSchema = z.strictObject({
  name: Name,
  dir: z.string(),
  kind: z.enum(["app", "lib", "root"]),
  tags: z.array(z.string()),
  layer: z.string().optional(),
  files: z.number().int().nonnegative(),
  testFiles: z.number().int().nonnegative(),
  owners: z.array(z.string()),
  dependsOn: z.array(Name),
  dependents: z.array(Name),
  metrics: MetricsSchema.optional(),
});
export type ArchPackage = z.output<typeof PackageSchema>;

const EdgeSchema = z.strictObject({
  from: Name,
  to: Name,
  /** Import statements from files of `from` to files of `to`. */
  imports: z.number().int().positive(),
  /** Of them, the ones that are not `import type`. */
  runtime: z.number().int().nonnegative(),
  /** Every import comes from a test file. */
  testOnly: z.boolean(),
  declared: z.enum([...DEPENDENCY_FIELDS, "none"]),
  samples: z.array(z.strictObject({ from: z.string(), to: z.string() })).max(5),
});
export type ArchEdge = z.output<typeof EdgeSchema>;

const CycleSchema = z.strictObject({
  packages: z.array(Name).min(2),
  edges: z.array(
    z.strictObject({ from: Name, to: Name, imports: z.number().int(), runtime: z.number().int() }),
  ),
  /** The cycle closes only through `import type`. */
  typeOnly: z.boolean(),
  /** The cheapest edges to remove so that no cycle is left (fewest imports to move). */
  cut: z.array(z.strictObject({ from: Name, to: Name, imports: z.number().int() })).optional(),
});
export type ArchCycle = z.output<typeof CycleSchema>;

const BoundariesSchema = z.strictObject({
  /** Groups of files inside one package that import each other but not the rest, used by different packages. */
  split: z.array(
    z.strictObject({
      package: Name,
      clusters: z.array(
        z.strictObject({
          files: z.number().int().positive(),
          sample: z.array(z.string()),
          consumers: z.array(Name),
        }),
      ),
    }),
  ),
  /** Packages with exactly one dependent that could live inside it. */
  merge: z.array(z.strictObject({ package: Name, into: Name, reason: z.string() })),
  /** Packages many depend on and that depend on many. */
  hubs: z.array(z.strictObject({ package: Name, fanIn: z.number().int(), fanOut: z.number().int() })),
  /** Exported symbols no other file imports. */
  deadExports: z.array(z.strictObject({ package: Name, file: z.string(), name: z.string() })),
  /** Library packages nothing depends on. */
  deadPackages: z.array(Name),
});

const CouplingSchema = z.strictObject({
  a: Name,
  b: Name,
  /** Commits that changed both packages. */
  together: z.number().int().positive(),
  /** together / commits that changed either. */
  ratio: z.number().min(0).max(1),
  dependency: z.enum(["none", "a-to-b", "b-to-a", "both"]),
});

const TeamsSchema = z.strictObject({
  edges: z.array(z.strictObject({ from: z.string(), to: z.string(), imports: z.number().int() })),
  unowned: z.array(Name),
});

const AppsSchema = z.strictObject({
  /** Every workspace package each application pulls in. */
  closure: z.array(z.strictObject({ app: Name, packages: z.array(Name) })),
  /** Applications a change to each package reaches, widest first. */
  blastRadius: z.array(z.strictObject({ package: Name, apps: z.array(Name) })),
});

export const ArchitectureReportSchema = z.strictObject({
  /** The policy file used, or null for the defaults. */
  policy: z.string().nullable(),
  summary: z.strictObject({
    packages: z.number().int(),
    apps: z.number().int(),
    edges: z.number().int(),
    cycles: z.number().int(),
    errors: z.number().int(),
    warnings: z.number().int(),
    /** Violations a policy exception covers. */
    excepted: z.number().int(),
    /** 100 minus 5 per error and 1 per warning, never below 0. */
    score: z.number().int().min(0).max(100),
  }),
  packages: z.array(PackageSchema),
  edges: z.array(EdgeSchema),
  cycles: z.array(CycleSchema),
  violations: z.array(ViolationSchema),
  boundaries: BoundariesSchema.optional(),
  coupling: z.array(CouplingSchema).optional(),
  teams: TeamsSchema.optional(),
  apps: AppsSchema.optional(),
  /** Imports the analyzer could not resolve: the limit of what this report can see. */
  unresolved: z.strictObject({
    count: z.number().int(),
    sample: z.array(z.strictObject({ from: z.string(), specifier: z.string() })).max(50),
  }),
});
export type ArchitectureReport = z.output<typeof ArchitectureReportSchema>;

export const ArchitectureReportDocument = defineDocument("ArchitectureReport", {
  latest: ArchitectureReportSchema,
});

// ---------------------------------------------------------------------------------------------
// The analysis

export interface ResolvedImport {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
}

export interface ExternalImport {
  readonly from: string;
  /** Package name (`lodash`, `@scope/pkg`) or builtin (`node:fs`, `bun:test`). */
  readonly name: string;
  readonly typeOnly: boolean;
}

export interface ArchitectureInput {
  readonly files: readonly string[];
  readonly imports: readonly ResolvedImport[];
  readonly externals: readonly ExternalImport[];
  readonly unresolved: readonly { readonly from: string; readonly specifier: string }[];
  readonly manifests: ManifestSet;
  readonly policy: ArchitecturePolicy;
  readonly policySource: string | null;
  /** `YYYY-MM-DD`, for exceptions that expire. */
  readonly today: string;
  readonly owners?: ReadonlyMap<string, readonly string[]>;
  /** File → package, overriding directories (what a simulated move changes). */
  readonly placement?: ReadonlyMap<string, string>;
  /** Packages a simulated move creates. */
  readonly extraPackages?: readonly PackageManifest[];
  /** Exported and imported names of every source module (H3: metrics, dead exports, split). */
  readonly modules?: ReadonlyMap<string, ResolvedModule>;
  /** Files changed by each recent commit, newest first (H3: what changes together). */
  readonly history?: readonly (readonly string[])[];
}

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** Modules the runtime provides, not a package: Node and Bun builtins, k6's modules in load tests. */
const isBuiltin = (name: string) =>
  name.startsWith("node:") || name.startsWith("bun:") || name === "bun" || name === "k6";
/** `express` → `@types/express`, `@scope/pkg` → `@types/scope__pkg`. */
const typesOf = (name: string) => `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;

interface EdgeAcc {
  imports: number;
  runtime: number;
  testOnly: boolean;
  samples: { from: string; to: string }[];
  relative: { file: string; to: string; specifier: string }[];
}

const pairKey = (a: string, b: string) => `${a}\u0000${b}`;
const byName = (a: string, b: string) => a.localeCompare(b);

/** The package graph and everything wrong with it, for one state of the repository. */
export function analyzeArchitecture(input: ArchitectureInput): ArchitectureReport {
  const { policy } = input;
  const manifests = [...input.manifests.packages, ...(input.extraPackages ?? [])];
  const byPackage = new Map(manifests.map((m) => [m.name, m]));
  const refs = manifests.map((m) => ({ name: m.name, dir: m.dir }));
  const tests = policy.tests ?? ARCH_TEST_GLOBS;
  const ignored = (file: string) => policy.ignore.length > 0 && matchesAny(file, policy.ignore);
  const isTest = (file: string) => matchesAny(file, tests);
  const pkgOf = (file: string) => input.placement?.get(file) ?? packageOf(file, refs)?.name ?? ROOT_PACKAGE;
  // A workspace package every declaring package lists in devDependencies only (a shared lint or
  // TypeScript config) is a tool: its files run at check time, never in production.
  const declarers = [input.manifests.root, ...manifests].filter((m) => m !== undefined);
  const devTools = new Set(
    manifests
      .map((m) => m.name)
      .filter((name) => {
        const fields = declarers.flatMap((m) => DEPENDENCY_FIELDS.filter((f) => m[f][name] !== undefined));
        return fields.length > 0 && fields.every((f) => f === "devDependencies");
      }),
  );
  /** Files that may use devDependencies: tests, tool configuration and tool packages. */
  const devOnly = (file: string) =>
    isTest(file) || matchesAny(file, ARCH_TOOLING_GLOBS) || devTools.has(pkgOf(file));

  // Files per package.
  const files = new Map<string, { files: number; tests: number }>();
  for (const file of input.files) {
    if (ignored(file)) continue;
    const p = pkgOf(file);
    const entry = files.get(p) ?? { files: 0, tests: 0 };
    entry.files++;
    if (isTest(file)) entry.tests++;
    files.set(p, entry);
  }

  // Package edges.
  const acc = new Map<string, EdgeAcc>();
  const used = new Map<string, Set<string>>(); // package → dependency names its files import
  const use = (p: string, name: string) => {
    const set = used.get(p) ?? new Set<string>();
    set.add(name);
    used.set(p, set);
  };
  // A workspace package imported by name but not linked (no install yet) still is a dependency.
  const unlinked = input.externals.flatMap((x) => {
    const target = byPackage.get(x.name);
    return target
      ? [{ from: x.from, to: `${target.dir}/package.json`, specifier: x.name, typeOnly: x.typeOnly }]
      : [];
  });
  for (const imp of [...input.imports, ...unlinked]) {
    if (ignored(imp.from) || ignored(imp.to)) continue;
    const a = pkgOf(imp.from);
    const b = pkgOf(imp.to);
    if (a === b) continue;
    use(a, b);
    const key = pairKey(a, b);
    const e = acc.get(key) ?? { imports: 0, runtime: 0, testOnly: true, samples: [], relative: [] };
    acc.set(key, e);
    e.imports++;
    if (!imp.typeOnly) e.runtime++;
    if (!devOnly(imp.from)) e.testOnly = false;
    if (e.samples.length < 5 && !e.samples.some((s) => s.from === imp.from && s.to === imp.to))
      e.samples.push({ from: imp.from, to: imp.to });
    if (imp.specifier.startsWith(".") && e.relative.length < 5)
      e.relative.push({ file: imp.from, to: imp.to, specifier: imp.specifier });
  }

  const edges: ArchEdge[] = [...acc.entries()]
    .map(([key, e]) => {
      const [from, to] = key.split("\u0000") as [string, string];
      return {
        from,
        to,
        imports: e.imports,
        runtime: e.runtime,
        testOnly: e.testOnly,
        declared: (declaredIn(byPackage.get(from), to) ?? "none") as ArchEdge["declared"],
        samples: e.samples,
      };
    })
    .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
  const production = edges.filter((e) => !e.testOnly);

  // Packages.
  const names = new Set([...manifests.map((m) => m.name), ...files.keys()]);
  const dependsOn = (p: string) => production.filter((e) => e.from === p).map((e) => e.to);
  const dependents = (p: string) => production.filter((e) => e.to === p).map((e) => e.from);
  const packages: ArchPackage[] = [...names]
    .filter((n) => n !== ROOT_PACKAGE || (files.get(n)?.files ?? 0) > 0)
    .sort(byName)
    .map((name) => {
      const m = byPackage.get(name);
      const dir = m?.dir ?? ".";
      const tags = m ? tagsOf(policy, m) : [];
      const layer = m ? layerOf(policy, m, tags) : undefined;
      return {
        name,
        dir,
        kind: kindOf(policy, m, dependents(name).filter((d) => d !== ROOT_PACKAGE).length),
        tags,
        ...(layer === undefined ? {} : { layer: policy.layers[layer]?.name as string }),
        files: files.get(name)?.files ?? 0,
        testFiles: files.get(name)?.tests ?? 0,
        owners: [...(input.owners?.get(name) ?? [])],
        dependsOn: dependsOn(name).sort(byName),
        dependents: dependents(name).sort(byName),
      };
    });
  const pkg = new Map(packages.map((p) => [p.name, p]));

  const violations: Violation[] = [];
  const add = (
    kind: ViolationKind,
    subject: string,
    message: string,
    pkgs: readonly string[],
    evidence: Violation["evidence"] = [],
  ) =>
    violations.push({
      id: `${kind}:${subject}`,
      kind,
      severity: DEFAULT_SEVERITY[kind],
      message,
      packages: [...pkgs],
      evidence: evidence.slice(0, 5),
    });
  const samplesOf = (e: ArchEdge) => e.samples.map((s) => ({ file: s.from, to: s.to }));

  // Cycles between packages (test-only edges never make one).
  const cycles = packageCycles(production.filter((e) => e.from !== ROOT_PACKAGE && e.to !== ROOT_PACKAGE));
  for (const c of cycles) {
    add(
      "cycle",
      c.packages.join(","),
      `${c.packages.join(" ⇄ ")} depend on each other${c.typeOnly ? " (only through import type)" : ""}`,
      c.packages,
      c.edges.flatMap((ce) => {
        const e = edges.find((x) => x.from === ce.from && x.to === ce.to);
        return e ? samplesOf(e).slice(0, 1) : [];
      }),
    );
    // A cycle only `import type` closes costs type checking, not runtime: a warning by default.
    if (c.typeOnly) (violations.at(-1) as Violation).severity = "warning";
  }

  for (const e of edges) {
    if (e.from === ROOT_PACKAGE) continue;
    const relative = acc.get(pairKey(e.from, e.to))?.relative ?? [];
    if (relative.length > 0)
      add(
        "relative-import",
        `${e.from}→${e.to}`,
        `${e.from} reaches into ${e.to} with a relative path instead of its package name`,
        [e.from, e.to],
        relative,
      );
    if (e.to === ROOT_PACKAGE) continue;
    if (e.declared === "none")
      add(
        "undeclared",
        `${e.from}→${e.to}`,
        `${e.from} imports the workspace package ${e.to} without declaring it in package.json`,
        [e.from, e.to],
        samplesOf(e),
      );
    else if (e.declared === "devDependencies" && !e.testOnly)
      add(
        "dev-in-prod",
        `${e.from}→${e.to}`,
        `${e.from} imports ${e.to} outside tests, but declares it only in devDependencies`,
        [e.from, e.to],
        samplesOf(e),
      );
    if (!e.testOnly && pkg.get(e.to)?.kind === "app")
      add(
        "app-import",
        `${e.from}→${e.to}`,
        `${e.from} depends on the application ${e.to}; applications sit on top and nothing imports them`,
        [e.from, e.to],
        samplesOf(e),
      );
  }

  // External packages: declared where they are imported.
  const externals = new Map<string, { files: string[]; prod: boolean; runtimeProd: boolean }>();
  for (const x of input.externals) {
    if (ignored(x.from) || isBuiltin(x.name) || !NPM_NAME.test(x.name)) continue;
    const p = pkgOf(x.from);
    use(p, x.name);
    if (p === ROOT_PACKAGE || byPackage.has(x.name)) continue;
    const key = pairKey(p, x.name);
    const entry = externals.get(key) ?? { files: [], prod: false, runtimeProd: false };
    if (entry.files.length < 5) entry.files.push(x.from);
    if (!devOnly(x.from)) {
      entry.prod = true;
      if (!x.typeOnly) entry.runtimeProd = true;
    }
    externals.set(key, entry);
  }
  for (const [key, x] of [...externals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [p, name] = key.split("\u0000") as [string, string];
    const field = declaredIn(byPackage.get(p), name);
    const evidence = x.files.map((file) => ({ file, specifier: name }));
    // `import { Request } from "express"` with @types/express declared: the types are what is
    // used (TypeScript drops the import), as in a NestJS app on top of @nestjs/platform-express.
    if (field === undefined && declaredIn(byPackage.get(p), typesOf(name)) !== undefined) continue;
    if (field === undefined) {
      if (declaredIn(input.manifests.root, name) !== undefined)
        add(
          "root-only",
          `${p}→${name}`,
          `${p} imports ${name}, declared only by the repository root (works through hoisting)`,
          [p],
          evidence,
        );
      else
        add(
          "undeclared",
          `${p}→${name}`,
          `${p} imports ${name} without declaring it in package.json`,
          [p],
          evidence,
        );
    } else if (field === "devDependencies" && x.runtimeProd)
      add(
        "dev-in-prod",
        `${p}→${name}`,
        `${p} imports ${name} outside tests, but declares it only in devDependencies`,
        [p],
        evidence,
      );
  }

  // Declared dependencies nothing imports (scripts and @types count as uses).
  for (const m of input.manifests.packages) {
    if (m.dir === ".") continue;
    const imported = used.get(m.name) ?? new Set<string>();
    const scripts = Object.values(m.scripts).join("\n");
    for (const name of Object.keys(m.dependencies).sort()) {
      if (imported.has(name) || name.startsWith("@types/") || scripts.includes(name)) continue;
      add(
        "unused-dependency",
        `${m.name}→${name}`,
        `${m.name} declares ${name} in dependencies, but no file imports it`,
        [m.name],
        [{ file: `${m.dir}/package.json`, specifier: name }],
      );
    }
  }

  // One dependency, several version ranges.
  const ranges = new Map<string, Map<string, string[]>>();
  for (const m of [...(input.manifests.root ? [input.manifests.root] : []), ...input.manifests.packages]) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      for (const [name, range] of Object.entries(m[field])) {
        if (/^(workspace|link|file|portal|catalog):/.test(range) || byPackage.has(name)) continue;
        const forName = ranges.get(name) ?? new Map<string, string[]>();
        forName.set(range, [...new Set([...(forName.get(range) ?? []), m.name])]);
        ranges.set(name, forName);
      }
    }
  }
  for (const [name, byRange] of [...ranges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (byRange.size < 2) continue;
    const list = [...byRange.entries()].sort(([a], [b]) => a.localeCompare(b));
    add(
      "version-drift",
      name,
      `${name} is declared with ${list.length} ranges: ${list.map(([r, ps]) => `${r} (${ps.join(", ")})`).join("; ")}`,
      [...new Set(list.flatMap(([, ps]) => ps))].sort(byName),
      list.flatMap(([r, ps]) =>
        ps.map((p) => ({ file: `${byPackage.get(p)?.dir ?? "."}/package.json`, specifier: `${name}@${r}` })),
      ),
    );
  }

  // Layers and tag rules.
  const layerIndex = (name: string) => {
    const layer = pkg.get(name)?.layer;
    return layer === undefined ? undefined : policy.layers.findIndex((l) => l.name === layer);
  };
  for (const e of production) {
    if (e.from === ROOT_PACKAGE || e.to === ROOT_PACKAGE) continue;
    const a = layerIndex(e.from);
    const b = layerIndex(e.to);
    if (a !== undefined && b !== undefined && b < a)
      add(
        "layer",
        `${e.from}→${e.to}`,
        `${e.from} (layer ${policy.layers[a]?.name}) depends on ${e.to} (layer ${policy.layers[b]?.name}, above it)`,
        [e.from, e.to],
        samplesOf(e),
      );
    const broken = brokenTagRules(policy, pkg.get(e.from)?.tags ?? [], pkg.get(e.to)?.tags ?? []);
    if (broken.length > 0)
      add(
        "tag",
        `${e.from}→${e.to}`,
        `${e.from} → ${e.to}: ${broken.join("; ")}`,
        [e.from, e.to],
        samplesOf(e),
      );
  }
  if (policy.layers.length > 0)
    for (const p of packages)
      if (p.kind !== "root" && p.layer === undefined)
        add("unlayered", p.name, `${p.name} belongs to no layer, so its dependencies are not checked`, [
          p.name,
        ]);

  // H3: metrics, thresholds, boundaries, history, teams, applications.
  const workspace = packages.filter((p) => p.kind !== "root");
  const wsEdges = production.filter((e) => e.from !== ROOT_PACKAGE && e.to !== ROOT_PACKAGE);
  const modules = input.modules ?? new Map<string, ResolvedModule>();
  const counted = (file: string) => !ignored(file) && !devOnly(file);
  const barrel = (file: string) =>
    /(^|\/)index\.[cm]?[jt]sx?$/.test(file) || (byPackage.get(pkgOf(file))?.entries.includes(file) ?? false);
  // Imports of a workspace package by name that is not linked (no install): its entry files,
  // wholly, since the names imported were not resolved.
  const unlinkedSeeds = input.externals.flatMap((x) =>
    (byPackage.get(x.name)?.entries ?? [])
      .filter((f) => modules.has(f))
      .map((target) => ({ from: x.from, target, imported: "*" })),
  );
  const seedsFrom = (keep: (from: string, target: string) => boolean, tests = false) => {
    const usable = (from: string) => counted(from) || (tests && !ignored(from));
    return [
      ...[...modules.entries()].flatMap(([from, m]) =>
        usable(from)
          ? m.imports
              .filter((i) => keep(from, i.target))
              .map((i) => ({ target: i.target, imported: i.imported }))
          : [],
      ),
      ...unlinkedSeeds
        .filter((s) => usable(s.from) && keep(s.from, s.target))
        .map((s) => ({ target: s.target, imported: s.imported })),
    ];
  };
  const usedOutside = reachedExports(
    modules,
    seedsFrom((from, target) => pkgOf(from) !== pkgOf(target)),
  );
  // The public API of a published package counts as used: its users live outside the repository.
  const publicApi = manifests
    .filter((m) => !m.private)
    .flatMap((m) => m.entries.filter((f) => modules.has(f)).map((target) => ({ target, imported: "*" })));
  // Tests count as users here (an export for a test is not dead), not for use by other packages.
  const usedAnywhere = reachedExports(modules, [...seedsFrom(() => true, true), ...publicApi]);
  const exportCounts = new Map<string, { total: number; types: number; used: number }>();
  for (const [file, m] of modules) {
    if (!counted(file)) continue;
    const c = exportCounts.get(pkgOf(file)) ?? { total: 0, types: 0, used: 0 };
    for (const e of m.exports) {
      c.total++;
      if (e.typeOnly) c.types++;
      if (usedOutside.has(`${file}\u0000${e.name}`)) c.used++;
    }
    exportCounts.set(pkgOf(file), c);
  }
  const depthOf = depths(
    workspace.map((p) => p.name),
    wsEdges,
  );
  const withMetrics: ArchPackage[] = packages.map((p) => {
    if (p.kind === "root") return p;
    const c = exportCounts.get(p.name) ?? { total: 0, types: 0, used: 0 };
    const metrics = metricsOf({
      dependsOn: wsEdges.filter((e) => e.from === p.name).length,
      dependents: wsEdges.filter((e) => e.to === p.name).length,
      depth: depthOf.get(p.name) ?? 0,
      exports: c.total,
      typeExports: c.types,
      usedOutside: c.used,
    });
    for (const t of overThresholds(policy.thresholds, {
      distance: metrics.distance,
      fanOut: metrics.ce,
      fanIn: metrics.ca,
      files: p.files - p.testFiles,
      depth: metrics.depth,
    }))
      add(
        "threshold",
        `${p.name}:${t.metric}`,
        `${p.name}: ${t.metric} ${t.value} is over the threshold ${t.limit}`,
        [p.name],
      );
    return { ...p, metrics };
  });

  // Who uses which file of a package, also through its barrels.
  const consumers = new Map<string, Set<string>>();
  const consume = (file: string, by: string) => {
    const set = consumers.get(file) ?? new Set<string>();
    set.add(by);
    consumers.set(file, set);
  };
  for (const imp of input.imports)
    if (counted(imp.from) && !ignored(imp.to) && pkgOf(imp.from) !== pkgOf(imp.to))
      consume(imp.to, pkgOf(imp.from));
  for (const [from, m] of modules) {
    if (!counted(from)) continue;
    for (const i of m.imports) {
      if (pkgOf(i.target) === pkgOf(from) || i.imported === "*") continue;
      const def = definitionOf(modules, i.target, i.imported);
      if (def) consume(def, pkgOf(from));
    }
  }
  const split: NonNullable<ArchitectureReport["boundaries"]>["split"] = [];
  for (const p of workspace) {
    if (p.kind !== "lib") continue;
    const own = input.files.filter((f) => counted(f) && pkgOf(f) === p.name && !barrel(f));
    if (own.length < 6) continue;
    const ownSet = new Set(own);
    const inner = input.imports.filter((i) => ownSet.has(i.from) && ownSet.has(i.to));
    const clusters = fileClusters(own, inner)
      .filter((c) => c.length >= 2)
      .map((c) => ({
        files: c.length,
        sample: c.slice(0, 3),
        consumers: [...new Set(c.flatMap((f) => [...(consumers.get(f) ?? [])]))].sort(),
      }));
    const used = clusters.filter((c) => c.consumers.length > 0);
    if (used.length >= 2 && new Set(used.map((c) => c.consumers.join(","))).size > 1)
      split.push({ package: p.name, clusters: used });
  }
  const isPrivate = (name: string) => byPackage.get(name)?.private ?? false;
  const deadExports: NonNullable<ArchitectureReport["boundaries"]>["deadExports"] = [];
  const imported = new Set(input.imports.map((i) => i.to));
  for (const [file, m] of [...modules.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const owner = pkg.get(pkgOf(file));
    if (!counted(file) || !owner || owner.kind === "root") continue;
    for (const e of m.exports) {
      if (owner.kind === "app" && e.name === "default") continue; // frameworks load default exports
      if (owner.kind === "app" && !imported.has(file)) continue; // an application's entry point
      if (!usedAnywhere.has(`${file}\u0000${e.name}`))
        deadExports.push({ package: owner.name, file, name: e.name });
    }
  }
  const boundaries: NonNullable<ArchitectureReport["boundaries"]> = {
    split,
    merge: mergeCandidates(workspace, isPrivate),
    hubs: withMetrics
      .filter((p) => p.metrics && p.metrics.ca >= 3 && p.metrics.ce >= 3)
      .map((p) => ({ package: p.name, fanIn: p.metrics?.ca ?? 0, fanOut: p.metrics?.ce ?? 0 })),
    deadExports: deadExports.slice(0, 200),
    // A package only tests use (a testing library) is used: test edges count here.
    deadPackages: workspace
      .filter((p) => p.kind === "lib" && isPrivate(p.name) && !edges.some((e) => e.to === p.name))
      .map((p) => p.name),
  };

  const ownersOf = (name: string) => [...(input.owners?.get(name) ?? [])].sort().join(", ");
  const teamEdges = new Map<string, number>();
  if (input.owners && input.owners.size > 0)
    for (const e of wsEdges) {
      const a = ownersOf(e.from) || "(no owner)";
      const b = ownersOf(e.to) || "(no owner)";
      if (a !== b) teamEdges.set(`${a}\u0000${b}`, (teamEdges.get(`${a}\u0000${b}`) ?? 0) + e.imports);
    }
  const linked = (a: string, b: string) => wsEdges.some((e) => e.from === a && e.to === b);
  const apps = workspace.filter((p) => p.kind === "app").map((p) => p.name);

  const final = applyPolicy(violations, policy, input.today);
  return {
    policy: input.policySource,
    summary: summarize(packages, edges, cycles, final),
    packages: withMetrics,
    boundaries,
    ...(input.history
      ? {
          coupling: changeCoupling(input.history, (f) => {
            const p = pkgOf(f);
            return p === ROOT_PACKAGE || ignored(f) ? undefined : p;
          })
            .slice(0, 30)
            .map((c) => ({
              ...c,
              dependency: (linked(c.a, c.b) && linked(c.b, c.a)
                ? "both"
                : linked(c.a, c.b)
                  ? "a-to-b"
                  : linked(c.b, c.a)
                    ? "b-to-a"
                    : "none") as "none" | "a-to-b" | "b-to-a" | "both",
            })),
        }
      : {}),
    ...(input.owners && input.owners.size > 0
      ? {
          teams: {
            edges: [...teamEdges.entries()]
              .map(([key, imports]) => {
                const [from, to] = key.split("\u0000") as [string, string];
                return { from, to, imports };
              })
              .sort(
                (a, b) => b.imports - a.imports || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
              ),
            unowned: workspace.filter((p) => p.owners.length === 0).map((p) => p.name),
          },
        }
      : {}),
    ...(apps.length > 0 ? { apps: appReach(apps, wsEdges) } : {}),
    edges,
    cycles,
    violations: final,
    unresolved: {
      count: input.unresolved.length,
      sample: input.unresolved.slice(0, 50).map((u) => ({ ...u })),
    },
  };
}

/**
 * Private libraries with one dependent that could live inside it. Not proposed: a family of
 * three or more packages with the same single dependent and the same dependencies (adapters of
 * one port, plugins of one host: separate on purpose), or a pair in different layers or tags.
 */
function mergeCandidates(
  workspace: readonly ArchPackage[],
  isPrivate: (name: string) => boolean,
): { package: string; into: string; reason: string }[] {
  const byName = new Map(workspace.map((p) => [p.name, p]));
  const candidates = workspace.flatMap((p) => {
    const users = p.dependents.filter((d) => d !== ROOT_PACKAGE);
    const into = byName.get(users[0] ?? "");
    if (
      p.kind !== "lib" ||
      !isPrivate(p.name) ||
      users.length !== 1 ||
      !into ||
      p.dependsOn.includes(into.name)
    )
      return [];
    if (p.layer !== into.layer || p.tags.join(",") !== into.tags.join(",")) return [];
    return [{ p, into, family: `${into.name}\u0000${p.dependsOn.join(",")}` }];
  });
  const families = new Map<string, number>();
  for (const c of candidates) families.set(c.family, (families.get(c.family) ?? 0) + 1);
  return candidates
    .filter((c) => (families.get(c.family) ?? 0) < 3)
    .map(({ p, into }) => ({
      package: p.name,
      into: into.name,
      reason: `only ${into.name} depends on it (${p.files - p.testFiles} files)`,
    }));
}

function kindOf(
  policy: ArchitecturePolicy,
  m: PackageManifest | undefined,
  dependents: number,
): ArchPackage["kind"] {
  if (!m) return "root";
  for (const rule of policy.packages)
    if (rule.kind && rule.packages.some((p) => matchesPackage(p, m))) return rule.kind;
  if (m.projectType) return m.projectType === "application" ? "app" : "lib";
  if (m.dir === "apps" || m.dir.startsWith("apps/")) return "app";
  // A package others import is a library, even with a `bin` (a tool that is also a library, like
  // typescript); mark an imported application with `kind: app` in the policy to check app-import.
  if (dependents > 0) return "lib";
  const runnable = ["start", "dev", "serve"].some((s) => m.scripts[s] !== undefined);
  return m.bin || (runnable && !m.entry) ? "app" : "lib";
}

/** Strongly connected components of more than one package, with their inner edges. */
export function packageCycles(edges: readonly ArchEdge[]): ArchCycle[] {
  const graph = new Graph({ directed: true });
  const runtime = new Graph({ directed: true });
  for (const e of edges) {
    graph.setEdge(e.from, e.to);
    if (e.runtime > 0) runtime.setEdge(e.from, e.to);
  }
  const runtimeSets = alg.tarjan(runtime).map((c) => new Set(c));
  return alg
    .tarjan(graph)
    .filter((c) => c.length > 1)
    .map((c) => {
      const members = new Set(c);
      const inner = edges
        .filter((e) => members.has(e.from) && members.has(e.to))
        .map((e) => ({ from: e.from, to: e.to, imports: e.imports, runtime: e.runtime }));
      // Type-only when no runtime cycle runs through it: a runtime SCC inside it is a runtime cycle.
      const typeOnly = !runtimeSets.some((r) => r.size > 1 && [...r].every((p) => members.has(p)));
      const packages = [...c].sort(byName);
      return { packages, edges: inner, typeOnly, cut: cheapestCut({ packages, edges: inner }) };
    })
    .sort((a, b) => (a.packages[0] ?? "").localeCompare(b.packages[0] ?? ""));
}

/** An exception's `violation`: an id, or a pattern where `*` stands for any text. */
export function matchesId(pattern: string, id: string): boolean {
  if (!pattern.includes("*")) return pattern === id;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(id);
}

/** Severities from the policy, then exceptions: covered, expired (an error) or unused (a warning). */
export function applyPolicy(
  violations: readonly Violation[],
  policy: ArchitecturePolicy,
  today: string,
): Violation[] {
  const out: Violation[] = [];
  const usedExceptions = new Set<number>();
  for (const v of violations) {
    const severity = policy.severity[v.kind] ?? v.severity;
    if (severity === "off") continue;
    const index = policy.exceptions.findIndex((x) => matchesId(x.violation, v.id));
    const exception = policy.exceptions[index];
    if (exception) usedExceptions.add(index);
    out.push({
      ...v,
      severity: severity as ArchSeverity,
      ...(exception && exception.expires >= today
        ? { exception: { reason: exception.reason, owner: exception.owner, expires: exception.expires } }
        : {}),
    });
  }
  const extra: Violation[] = [];
  policy.exceptions.forEach((x, i) => {
    const raise = (kind: ViolationKind, message: string) => {
      const severity = policy.severity[kind] ?? DEFAULT_SEVERITY[kind];
      if (severity !== "off")
        extra.push({
          id: `${kind}:${x.violation}`,
          kind,
          severity: severity as ArchSeverity,
          message,
          packages: [],
          evidence: [],
        });
    };
    if (!usedExceptions.has(i))
      raise(
        "unused-exception",
        `the exception for ${x.violation} (${x.owner}) matches no violation; remove it`,
      );
    else if (x.expires < today)
      raise("expired-exception", `the exception for ${x.violation} (${x.owner}) expired on ${x.expires}`);
  });
  const rank = (v: Violation) => (v.severity === "error" ? 0 : 1);
  return [...out, ...extra].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

function summarize(
  packages: readonly ArchPackage[],
  edges: readonly ArchEdge[],
  cycles: readonly ArchCycle[],
  violations: readonly Violation[],
): ArchitectureReport["summary"] {
  const active = violations.filter((v) => !v.exception);
  const errors = active.filter((v) => v.severity === "error").length;
  const warnings = active.length - errors;
  return {
    packages: packages.filter((p) => p.kind !== "root").length,
    apps: packages.filter((p) => p.kind === "app").length,
    edges: edges.filter((e) => !e.testOnly).length,
    cycles: cycles.length,
    errors,
    warnings,
    excepted: violations.length - active.length,
    score: Math.max(0, 100 - 5 * errors - warnings),
  };
}
