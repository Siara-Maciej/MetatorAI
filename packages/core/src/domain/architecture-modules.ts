import { alg, Graph } from "@dagrejs/graphlib";
import { matchesAny } from "./glob.ts";

/**
 * Modules inside a package (ADR-0074): in a modular monolith the folders a policy names
 * (`src/module/*`) are the units of the architecture, as packages are a monorepo's. Imports
 * between them are measured the same way: who depends on whom, which pairs depend on each other,
 * the cycles, and imports of another module's internals when the policy names its public part.
 */
export interface ModulesPolicy {
  /** Globs of module directories, e.g. `src/module/*`. */
  readonly globs: readonly string[];
  /** Paths inside a module others may import (`contracts/**`); without it every file is public. */
  readonly public?: readonly string[] | undefined;
}

export interface ModuleImport {
  readonly from: string;
  readonly to: string;
  readonly typeOnly: boolean;
}

export interface ArchModule {
  readonly name: string;
  readonly dir: string;
  readonly files: number;
  readonly dependsOn: string[];
  readonly dependents: string[];
}

export interface ModuleEdge {
  readonly from: string;
  readonly to: string;
  readonly imports: number;
  /** Of them, the ones that are not `import type`. */
  readonly runtime: number;
  readonly samples: { from: string; to: string }[];
  /** Imports of files outside the target's public part (only with `public`). */
  readonly internal: number;
  readonly internalSamples: { from: string; to: string }[];
}

export interface ModuleCycle {
  readonly modules: string[];
  readonly edges: { from: string; to: string; imports: number }[];
  /** The cycle closes only through `import type`. */
  readonly typeOnly: boolean;
}

export interface ModulesReport {
  readonly globs: string[];
  readonly public?: string[];
  readonly modules: ArchModule[];
  readonly edges: ModuleEdge[];
  /** Pairs that import each other directly: the first sign of a wrong boundary. */
  readonly twoWay: [string, string][];
  readonly cycles: ModuleCycle[];
}

const byName = (a: string, b: string) => a.localeCompare(b);

/** The module directory a file is in: the first segments of its path that a glob matches. */
export function moduleDirOf(file: string, globs: readonly string[]): string | undefined {
  const parts = file.split("/");
  for (const glob of globs) {
    const depth = glob.replace(/\/+$/, "").split("/").length;
    if (parts.length <= depth) continue; // the directory itself, not a file inside it
    const dir = parts.slice(0, depth).join("/");
    if (matchesAny(dir, [glob])) return dir;
  }
  return undefined;
}

/** Strongly connected components of more than one node (graphlib's Tarjan). */
function components(nodes: readonly string[], next: (n: string) => readonly string[]): string[][] {
  const graph = new Graph({ directed: true });
  for (const n of nodes) {
    graph.setNode(n);
    for (const m of next(n)) graph.setEdge(n, m);
  }
  return alg
    .tarjan(graph)
    .filter((c) => c.length > 1)
    .map((c) => [...c].sort(byName))
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

/**
 * The modules of the given files and the imports between them. Test files (`isTest`) are left
 * out: a test reaching into another module is not the architecture.
 */
export function analyzeModules(input: {
  readonly policy: ModulesPolicy;
  readonly files: readonly string[];
  readonly imports: readonly ModuleImport[];
  readonly isTest: (file: string) => boolean;
  /** The package a module directory is in: it names modules that share a folder name. */
  readonly packageOf?: (dir: string) => string;
}): ModulesReport {
  const { policy } = input;
  const dirOf = (f: string) => moduleDirOf(f, policy.globs);
  const dirs = [...new Set(input.files.map(dirOf).filter((d): d is string => d !== undefined))].sort(byName);
  // A module is named by its folder; folders of one name in different packages by package and
  // folder (`web/Auth`), and by their path when that is still not unique.
  const last = (d: string) => d.split("/").at(-1) as string;
  const clashes = (names: readonly string[]) => new Set(names.filter((n, i, all) => all.indexOf(n) !== i));
  const clash = clashes(dirs.map(last));
  const qualified = dirs.map((d) =>
    clash.has(last(d)) && input.packageOf ? `${input.packageOf(d)}/${last(d)}` : last(d),
  );
  const still = clashes(qualified);
  const nameOf = new Map(
    dirs.map((d, i) => [d, still.has(qualified[i] as string) ? d : (qualified[i] as string)]),
  );
  const moduleOf = (f: string) => {
    const d = dirOf(f);
    return d === undefined ? undefined : (nameOf.get(d) as string);
  };
  const isPublic = (file: string, dir: string) =>
    !policy.public || matchesAny(file.slice(dir.length + 1), policy.public);

  const fileCount = new Map<string, number>();
  for (const f of input.files) {
    const m = moduleOf(f);
    if (m && !input.isTest(f)) fileCount.set(m, (fileCount.get(m) ?? 0) + 1);
  }

  type Acc = {
    imports: number;
    runtime: number;
    samples: { from: string; to: string }[];
    internal: number;
    internalSamples: { from: string; to: string }[];
  };
  const acc = new Map<string, Acc>();
  for (const imp of input.imports) {
    if (input.isTest(imp.from)) continue;
    const a = moduleOf(imp.from);
    const b = moduleOf(imp.to);
    if (!a || !b || a === b) continue;
    const key = `${a}\u0000${b}`;
    const e = acc.get(key) ?? { imports: 0, runtime: 0, samples: [], internal: 0, internalSamples: [] };
    acc.set(key, e);
    e.imports++;
    if (!imp.typeOnly) e.runtime++;
    if (e.samples.length < 5) e.samples.push({ from: imp.from, to: imp.to });
    if (!isPublic(imp.to, dirOf(imp.to) as string)) {
      e.internal++;
      if (e.internalSamples.length < 5) e.internalSamples.push({ from: imp.from, to: imp.to });
    }
  }
  const edges: ModuleEdge[] = [...acc.entries()]
    .map(([key, e]) => {
      const [from, to] = key.split("\u0000") as [string, string];
      return { from, to, ...e };
    })
    .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
  const has = (a: string, b: string) => acc.has(`${a}\u0000${b}`);

  const names = dirs.map((d) => nameOf.get(d) as string);
  const out = (m: string) => edges.filter((e) => e.from === m).map((e) => e.to);
  const runtimeOut = (m: string) => edges.filter((e) => e.from === m && e.runtime > 0).map((e) => e.to);
  const runtimeCycles = components(names, runtimeOut).map((c) => new Set(c));
  const cycles: ModuleCycle[] = components(names, out).map((c) => {
    const members = new Set(c);
    return {
      modules: c,
      edges: edges
        .filter((e) => members.has(e.from) && members.has(e.to))
        .map((e) => ({ from: e.from, to: e.to, imports: e.imports })),
      typeOnly: !runtimeCycles.some((r) => [...r].every((m) => members.has(m))),
    };
  });

  return {
    globs: [...policy.globs],
    ...(policy.public ? { public: [...policy.public] } : {}),
    modules: dirs.map((dir) => {
      const name = nameOf.get(dir) as string;
      return {
        name,
        dir,
        files: fileCount.get(name) ?? 0,
        dependsOn: out(name).sort(byName),
        dependents: edges
          .filter((e) => e.to === name)
          .map((e) => e.from)
          .sort(byName),
      };
    }),
    edges,
    twoWay: edges
      .filter((e) => e.from < e.to && has(e.to, e.from))
      .map((e): [string, string] => [e.from, e.to]),
    cycles,
  };
}

/** Folders that look like the modules of a modular monolith: three or more siblings with code. */
export const MODULE_FOLDERS = ["module", "modules", "features", "domains", "contexts", "bounded-contexts"];

/** Module globs for a policy proposal (`arch init`): `<path>/module/*` with three or more modules. */
export function proposeModuleGlobs(files: readonly string[]): string[] {
  const children = new Map<string, Set<string>>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 0; i < parts.length - 2; i++) {
      if (!MODULE_FOLDERS.includes(parts[i] as string)) continue;
      const parent = parts.slice(0, i + 1).join("/");
      const set = children.get(parent) ?? new Set<string>();
      set.add(parts[i + 1] as string);
      children.set(parent, set);
    }
  }
  return [...children.entries()]
    .filter(([parent, set]) => set.size >= 3 && !parent.includes("node_modules"))
    .map(([parent]) => `${parent}/*`)
    .sort(byName);
}

export interface ModuleViolation {
  readonly kind: "module-cycle" | "module-internal";
  /** The id after the kind: stable across runs, so a baseline can accept it. */
  readonly subject: string;
  readonly message: string;
  readonly modules: readonly string[];
  readonly evidence: { file: string; to: string }[];
  /** A cycle only `import type` closes: it costs type checking, not runtime (a warning). */
  readonly typeOnly?: boolean;
}

/** What is wrong between modules: cycles, and imports past another module's public part. */
export function moduleViolations(report: ModulesReport): ModuleViolation[] {
  const out: ModuleViolation[] = [];
  for (const c of report.cycles) {
    const edges = report.edges.filter((e) => c.modules.includes(e.from) && c.modules.includes(e.to));
    out.push({
      kind: "module-cycle",
      subject: c.modules.join(","),
      message: `modules ${c.modules.join(" ⇄ ")} depend on each other${c.typeOnly ? " (only through import type)" : ""}`,
      modules: c.modules,
      evidence: edges.flatMap((e) => e.samples.slice(0, 1).map((s) => ({ file: s.from, to: s.to }))),
      ...(c.typeOnly ? { typeOnly: true } : {}),
    });
  }
  for (const e of report.edges) {
    if (e.internal === 0) continue;
    out.push({
      kind: "module-internal",
      subject: `${e.from}→${e.to}`,
      message: `${e.from} imports ${e.to} past its public part (${(report.public ?? []).join(", ")}) ${e.internal} time(s)`,
      modules: [e.from, e.to],
      evidence: e.internalSamples.map((s) => ({ file: s.from, to: s.to })),
    });
  }
  return out;
}
