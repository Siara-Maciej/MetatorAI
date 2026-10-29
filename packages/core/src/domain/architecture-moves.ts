import { z } from "zod";
import {
  type ArchitectureInput,
  type ArchitectureReport,
  analyzeArchitecture,
  DEPENDENCY_FIELDS,
  type PackageManifest,
  type ResolvedImport,
  ROOT_PACKAGE,
  type Violation,
} from "./architecture.ts";
import { matchesAny } from "./glob.ts";
import { packageOf } from "./import-index.ts";

/**
 * Refactor moves as data and their simulation (H4, ADR-0064). A move changes which package
 * owns which files (or which way one dependency points); the same analysis on the moved facts
 * says what the move fixes and what it breaks, before anyone edits code. Proposals by people or
 * agents are judged by these numbers.
 */
const Files = z.array(z.string().min(1)).min(1);
const PackageName = z.string().min(1);

export const MoveSchema = z.discriminatedUnion("type", [
  /** Files (paths or globs) go to another, existing package. */
  z.strictObject({ type: z.literal("move"), files: Files, to: PackageName }),
  /** Every file of one package goes into another; the first disappears. */
  z.strictObject({ type: z.literal("merge"), from: PackageName, into: PackageName }),
  /** Files leave for a new package. */
  z.strictObject({
    type: z.literal("extract"),
    files: Files,
    package: z.strictObject({ name: PackageName, dir: z.string().min(1) }),
  }),
  /** `from` stops depending on `to`; `to` depends on `from` instead (a port in `from`, its adapter in `to`). */
  z.strictObject({ type: z.literal("invert"), from: PackageName, to: PackageName }),
  /** A dependency is declared in a package's manifest. */
  z.strictObject({
    type: z.literal("declare"),
    package: PackageName,
    dependency: z.string().min(1),
    field: z.enum(DEPENDENCY_FIELDS).optional(),
  }),
]);
export type Move = z.output<typeof MoveSchema>;

export interface MoveEffect {
  readonly before: ArchitectureReport["summary"];
  readonly after: ArchitectureReport["summary"];
  /** Violations the moves fix and the ones they add (by id). */
  readonly fixed: readonly string[];
  readonly added: readonly Violation[];
  /** Import statements whose target changes package: what a codemod rewrites. */
  readonly rewrites: number;
  /** Dependencies the moves declare so that moved code keeps its imports. */
  readonly declared: readonly { readonly package: string; readonly dependency: string }[];
}

export interface Simulation {
  readonly input: ArchitectureInput;
  readonly report: ArchitectureReport;
  readonly effect: MoveEffect;
}

const describe = (m: Move): string => {
  switch (m.type) {
    case "move":
      return `move ${m.files.join(", ")} to ${m.to}`;
    case "merge":
      return `merge ${m.from} into ${m.into}`;
    case "extract":
      return `extract ${m.files.join(", ")} into ${m.package.name}`;
    case "invert":
      return `invert ${m.from} → ${m.to}`;
    case "declare":
      return `declare ${m.dependency} in ${m.package}`;
  }
};

/** Problems that make moves impossible (unknown packages, files matching nothing), or none. */
export function checkMoves(input: ArchitectureInput, moves: readonly Move[]): string[] {
  const known = new Set([...input.manifests.packages, ...(input.extraPackages ?? [])].map((p) => p.name));
  const problems: string[] = [];
  for (const m of moves) {
    const need = (name: string) => {
      if (!known.has(name)) problems.push(`${describe(m)}: there is no package ${name}`);
    };
    if (m.type === "move") need(m.to);
    if (m.type === "merge") {
      need(m.from);
      need(m.into);
      if (m.from === m.into) problems.push(`${describe(m)}: a package cannot merge into itself`);
    }
    if (m.type === "invert") {
      need(m.from);
      need(m.to);
      if (m.from === m.to) problems.push(`${describe(m)}: a package does not depend on itself`);
    }
    if (m.type === "declare") need(m.package);
    if (m.type === "extract") {
      if (known.has(m.package.name)) problems.push(`${describe(m)}: ${m.package.name} already exists`);
      const dir = m.package.dir.replace(/\/+$/, "");
      const clash = [...input.manifests.packages, ...(input.extraPackages ?? [])].find(
        (p) => p.dir === dir || p.dir.startsWith(`${dir}/`),
      );
      if (clash) problems.push(`${describe(m)}: ${dir} holds ${clash.name} already`);
      known.add(m.package.name);
    }
    if ((m.type === "move" || m.type === "extract") && !input.files.some((f) => matchesAny(f, m.files)))
      problems.push(`${describe(m)}: no source file matches`);
  }
  return problems;
}

const withDependency = (
  m: PackageManifest,
  dependency: string,
  field: (typeof DEPENDENCY_FIELDS)[number] = "dependencies",
) =>
  DEPENDENCY_FIELDS.some((f) => m[f][dependency] !== undefined)
    ? m
    : { ...m, [field]: { ...m[field], [dependency]: "workspace:*" } };

/**
 * The facts after the moves, in order. Moved code keeps its imports: the package that receives
 * files declares what they import, and packages that now reach moved files declare their new
 * owner (listed in `declared`), so a simulation shows the structure, not missing declarations.
 */
export function applyMoves(
  input: ArchitectureInput,
  moves: readonly Move[],
): { input: ArchitectureInput; declared: { package: string; dependency: string }[] } {
  const refs = () => manifests.map((m) => ({ name: m.name, dir: m.dir }));
  let manifests: PackageManifest[] = [...input.manifests.packages, ...(input.extraPackages ?? [])];
  const placement = new Map(input.placement ?? []);
  let imports: ResolvedImport[] = [...input.imports];
  let externals = [...input.externals];
  /** Imports a move creates (the reversed edge of an invert): declared like moved code. */
  const synthetic: ResolvedImport[] = [];
  const owner = (file: string) => placement.get(file) ?? packageOf(file, refs())?.name ?? ROOT_PACKAGE;
  const extra: PackageManifest[] = [...(input.extraPackages ?? [])];

  for (const m of moves) {
    if (m.type === "declare") {
      manifests = manifests.map((p) => (p.name === m.package ? withDependency(p, m.dependency, m.field) : p));
      continue;
    }
    if (m.type === "invert") {
      const fromFiles = input.files.filter((f) => owner(f) === m.from);
      const toFiles = input.files.filter((f) => owner(f) === m.to);
      const removed = imports.filter((i) => owner(i.from) === m.from && owner(i.to) === m.to);
      imports = imports.filter((i) => !removed.includes(i));
      // Imports by package name that are not linked (no install) are the same dependency.
      const byName = externals.filter((x) => x.name === m.to && owner(x.from) === m.from);
      externals = externals.filter((x) => !byName.includes(x));
      // The implementation now lives in `to` and imports the port from `from`.
      const impl = toFiles[0];
      const port = fromFiles[0];
      if (removed.length + byName.length > 0 && impl && port) {
        const reversed = { from: impl, to: port, specifier: m.from, typeOnly: false };
        imports.push(reversed);
        synthetic.push(reversed);
      }
      continue;
    }
    if (m.type === "extract") {
      const created = {
        name: m.package.name,
        dir: m.package.dir,
        private: true,
        dependencies: {},
        peerDependencies: {},
        optionalDependencies: {},
        devDependencies: {},
        entry: true,
        entries: [],
        bin: false,
        scripts: {},
        tags: [],
      } satisfies PackageManifest;
      manifests.push(created);
      extra.push(created);
    }
    const target = m.type === "merge" ? m.into : m.type === "move" ? m.to : m.package.name;
    const files =
      m.type === "merge"
        ? input.files.filter((f) => owner(f) === m.from)
        : input.files.filter((f) => matchesAny(f, m.files));
    for (const f of files) placement.set(f, target);
    if (m.type === "merge")
      // Whoever declared the merged package now declares the package it went into.
      manifests = manifests
        .filter((p) => p.name !== m.from)
        .map((p) => {
          const field = DEPENDENCY_FIELDS.find((f) => p[f][m.from] !== undefined);
          if (!field) return p;
          const { [m.from]: _, ...rest } = p[field];
          const renamed = { ...p, [field]: rest };
          return p.name === m.into ? renamed : withDependency(renamed, m.into, field);
        });
  }

  // Keep declarations true: every package declares the workspace packages its files now import.
  const declared: { package: string; dependency: string }[] = [];
  const touched = new Set(placement.keys());
  const byName = new Map(manifests.map((p) => [p.name, p]));
  for (const i of imports) {
    if (!touched.has(i.from) && !touched.has(i.to) && !synthetic.includes(i)) continue;
    const a = owner(i.from);
    const b = owner(i.to);
    const pa = byName.get(a);
    if (a === b || !pa || b === ROOT_PACKAGE || !byName.has(b)) continue;
    if (DEPENDENCY_FIELDS.some((f) => pa[f][b] !== undefined)) continue;
    byName.set(a, withDependency(pa, b));
    declared.push({ package: a, dependency: b });
  }
  // External packages the moved files import go with them, from the package they were in before.
  const earlier = [...input.manifests.packages, ...(input.extraPackages ?? [])];
  const ownerBefore = (file: string) =>
    input.placement?.get(file) ??
    packageOf(
      file,
      earlier.map((p) => ({ name: p.name, dir: p.dir })),
    )?.name;
  for (const x of externals) {
    if (!touched.has(x.from)) continue;
    const pa = byName.get(owner(x.from));
    const before = earlier.find((p) => p.name === ownerBefore(x.from));
    const field = before ? DEPENDENCY_FIELDS.find((f) => before[f][x.name] !== undefined) : undefined;
    if (!pa || !field || DEPENDENCY_FIELDS.some((f) => pa[f][x.name] !== undefined)) continue;
    byName.set(pa.name, { ...pa, [field]: { ...pa[field], [x.name]: before?.[field][x.name] ?? "*" } });
    declared.push({ package: pa.name, dependency: x.name });
  }
  // Declarations the moves made stale: a package that used a workspace package before and no
  // longer imports it after (its files moved, or the dependency was inverted) drops it.
  const pairs = (
    of: (file: string) => string | undefined,
    list: readonly ResolvedImport[],
    xs: readonly { readonly from: string; readonly name: string }[],
  ) =>
    new Set([
      ...list.map((i) => `${of(i.from)}\u0000${of(i.to)}`),
      ...xs.map((x) => `${of(x.from)}\u0000${x.name}`),
    ]);
  const usedBefore = pairs(ownerBefore, input.imports, input.externals);
  const usedAfter = pairs(owner, imports, externals);
  for (const [name, p] of byName)
    for (const field of DEPENDENCY_FIELDS)
      for (const dep of Object.keys(p[field])) {
        const key = `${name}\u0000${dep}`;
        if (!byName.has(dep) || !usedBefore.has(key) || usedAfter.has(key)) continue;
        const { [dep]: _, ...rest } = (byName.get(name) as PackageManifest)[field];
        byName.set(name, { ...(byName.get(name) as PackageManifest), [field]: rest });
      }
  const isExtra = new Set(extra.map((p) => p.name));
  const packages = [...byName.values()].filter((p) => !isExtra.has(p.name));
  const created = [...byName.values()].filter((p) => isExtra.has(p.name));
  return {
    input: {
      ...input,
      imports,
      externals,
      manifests: { ...input.manifests, packages },
      placement,
      ...(created.length > 0 ? { extraPackages: created } : {}),
    },
    declared: dedupe(declared),
  };
}

const dedupe = <T extends { package: string; dependency: string }>(list: readonly T[]): T[] => {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.package}\u0000${d.dependency}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Analyzes the facts before and after the moves and says what changed. */
export function simulateMoves(
  input: ArchitectureInput,
  moves: readonly Move[],
  before?: ArchitectureReport,
): Simulation {
  const base = before ?? analyzeArchitecture(input);
  const moved = applyMoves(input, moves);
  const report = analyzeArchitecture(moved.input);
  const active = (r: ArchitectureReport) => r.violations.filter((v) => !v.exception);
  const beforeIds = new Set(active(base).map((v) => v.id));
  const afterIds = new Set(active(report).map((v) => v.id));
  const ownerBefore = (file: string) =>
    input.placement?.get(file) ?? packageOf(file, input.manifests.packages)?.name ?? ROOT_PACKAGE;
  const ownerAfter = (file: string) =>
    moved.input.placement?.get(file) ??
    packageOf(file, [...moved.input.manifests.packages, ...(moved.input.extraPackages ?? [])])?.name ??
    ROOT_PACKAGE;
  // An import is rewritten when it now crosses into another package than before, or stops crossing.
  const kept = new Set(moved.input.imports);
  const keptExternals = new Set(moved.input.externals);
  const rewrites =
    input.externals.filter((x) => !keptExternals.has(x)).length +
    input.imports.filter((i) => {
      if (!kept.has(i)) return true; // an inverted dependency: the import goes away
      const was = ownerBefore(i.from) === ownerBefore(i.to) ? "same" : ownerBefore(i.to);
      const now = ownerAfter(i.from) === ownerAfter(i.to) ? "same" : ownerAfter(i.to);
      return was !== now;
    }).length;
  return {
    input: moved.input,
    report,
    effect: {
      before: base.summary,
      after: report.summary,
      fixed: [...beforeIds].filter((id) => !afterIds.has(id)).sort(),
      added: active(report).filter((v) => !beforeIds.has(v.id)),
      rewrites,
      declared: moved.declared,
    },
  };
}
