import type { ArchContext } from "./architecture-context.ts";
import { ROOT_PACKAGE } from "./architecture-manifests.ts";
import { appReach, changeCoupling, definitionOf, fileClusters } from "./architecture-metrics.ts";
import type { ArchitectureReport, ArchPackage } from "./architecture-report.ts";

type Boundaries = NonNullable<ArchitectureReport["boundaries"]>;

/**
 * Where the package boundaries could be drawn better (H3): packages to split or merge, hubs, and
 * exports and packages nothing uses. `withMetrics` is the packages as the report lists them.
 */
export function boundariesOf(ctx: ArchContext, withMetrics: readonly ArchPackage[]): Boundaries {
  const { byPackage, edges, workspace } = ctx;
  const isPrivate = (name: string) => byPackage.get(name)?.private ?? false;
  return {
    split: splitCandidates(ctx),
    merge: mergeCandidates(workspace, isPrivate),
    hubs: withMetrics
      .filter((p) => p.metrics && p.metrics.ca >= 3 && p.metrics.ce >= 3)
      .map((p) => ({ package: p.name, fanIn: p.metrics?.ca ?? 0, fanOut: p.metrics?.ce ?? 0 })),
    deadExports: deadExports(ctx).slice(0, 200),
    // A package only tests use (a testing library) is used: test edges count here.
    deadPackages: workspace
      .filter((p) => p.kind === "lib" && isPrivate(p.name) && !edges.some((e) => e.to === p.name))
      .map((p) => p.name),
  };
}

/** Libraries whose files fall into groups that different packages use. */
function splitCandidates(ctx: ArchContext): Boundaries["split"] {
  const { input, byPackage, ignored, pkgOf, counted, modules, workspace } = ctx;
  const barrel = (file: string) =>
    /(^|\/)index\.[cm]?[jt]sx?$/.test(file) || (byPackage.get(pkgOf(file))?.entries.includes(file) ?? false);
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
  const split: Boundaries["split"] = [];
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
  return split;
}

/** Exports no file uses, tests included; an application's entry points and default exports are left out. */
function deadExports(ctx: ArchContext): Boundaries["deadExports"] {
  const { input, pkg, pkgOf, counted, modules, usedAnywhere } = ctx;
  const out: Boundaries["deadExports"] = [];
  const imported = new Set(input.imports.map((i) => i.to));
  for (const [file, m] of [...modules.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const owner = pkg.get(pkgOf(file));
    if (!counted(file) || !owner || owner.kind === "root") continue;
    for (const e of m.exports) {
      if (owner.kind === "app" && e.name === "default") continue; // frameworks load default exports
      if (owner.kind === "app" && !imported.has(file)) continue; // an application's entry point
      if (!usedAnywhere.has(`${file}\u0000${e.name}`)) out.push({ package: owner.name, file, name: e.name });
    }
  }
  return out;
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

const linked = (ctx: ArchContext, a: string, b: string) =>
  ctx.wsEdges.some((e) => e.from === a && e.to === b);

/** Packages whose files change in the same commits, with the dependency between them. */
export function couplingOf(
  ctx: ArchContext,
  history: readonly (readonly string[])[],
): NonNullable<ArchitectureReport["coupling"]> {
  return changeCoupling(history, (f) => {
    const p = ctx.pkgOf(f);
    return p === ROOT_PACKAGE || ctx.ignored(f) ? undefined : p;
  })
    .slice(0, 30)
    .map((c) => ({
      ...c,
      dependency: (linked(ctx, c.a, c.b) && linked(ctx, c.b, c.a)
        ? "both"
        : linked(ctx, c.a, c.b)
          ? "a-to-b"
          : linked(ctx, c.b, c.a)
            ? "b-to-a"
            : "none") as "none" | "a-to-b" | "b-to-a" | "both",
    }));
}

/** Imports between teams (the owners of each end of an edge), and the packages nobody owns. */
export function teamsOf(
  ctx: ArchContext,
  owners: ReadonlyMap<string, readonly string[]>,
): NonNullable<ArchitectureReport["teams"]> {
  const ownersOf = (name: string) => [...(owners.get(name) ?? [])].sort().join(", ");
  const teamEdges = new Map<string, number>();
  for (const e of ctx.wsEdges) {
    const a = ownersOf(e.from) || "(no owner)";
    const b = ownersOf(e.to) || "(no owner)";
    if (a !== b) teamEdges.set(`${a}\u0000${b}`, (teamEdges.get(`${a}\u0000${b}`) ?? 0) + e.imports);
  }
  return {
    edges: [...teamEdges.entries()]
      .map(([key, imports]) => {
        const [from, to] = key.split("\u0000") as [string, string];
        return { from, to, imports };
      })
      .sort((a, b) => b.imports - a.imports || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    unowned: ctx.workspace.filter((p) => p.owners.length === 0).map((p) => p.name),
  };
}

/** What each application reaches, and which applications a package's change reaches. */
export function appsOf(ctx: ArchContext): ArchitectureReport["apps"] {
  const apps = ctx.workspace.filter((p) => p.kind === "app").map((p) => p.name);
  return apps.length > 0 ? appReach(apps, ctx.wsEdges) : undefined;
}
