import { type Application, type Contract, parseConsumes, type SystemMap } from "./system-map.ts";

/**
 * Where a change lands across the system (F7.3, ADR-0068): from the files a change touches (or the
 * contracts it names) to the contracts whose specification or implementation changed, their
 * consumers and the owners to talk to. Computed from the map; other repositories are read only
 * where their files are needed.
 */
export interface SystemImpact {
  readonly applications: readonly {
    readonly id: string;
    /** Why it is affected: its files changed, or it consumes a changed contract. */
    readonly reasons: readonly string[];
    readonly owners: readonly string[];
    readonly source: Application["source"];
  }[];
  readonly contracts: readonly {
    readonly id: string;
    readonly owner: string;
    /** spec: its specification changed; implementation: other files of its provider did; named: asked for. */
    readonly change: "spec" | "implementation" | "named";
    readonly consumers: readonly { readonly app: string; readonly version?: string }[];
  }[];
  /** Changed files that belong to no application of the map. */
  readonly unmapped: readonly string[];
}

/** `git@github.com:acme/web.git`, `https://github.com/acme/web` and `github.com/acme/web` are one repository. */
export function sameRepository(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/\.git$/, "")
      .replace(/^[a-z+]+:\/\//, "")
      .replace(/^[^@/]+@([^:]+):/, "$1/")
      .replace(/\/+$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

const join = (dir: string | undefined, path: string) =>
  !dir || dir === "." ? path : `${dir.replace(/\/+$/, "")}/${path}`;

/** The directory of an application inside its own repository ("." for the whole repository). */
export const appDir = (app: Application): string => app.source.path ?? ".";

/**
 * The applications whose code is in this repository: the configured ones, those whose `repo` is
 * this repository (remote or path), and, when the map itself lives here, those with only a path.
 */
export function selfApplications(
  map: SystemMap,
  here: {
    readonly configured?: readonly string[];
    readonly remote?: string;
    /** This repository's absolute path, and the path the map's relative repos start from. */
    readonly root: string;
    readonly mapIsLocal: boolean;
    readonly resolve: (repo: string) => string;
  },
): Application[] {
  if (here.configured) return map.applications.filter((a) => here.configured?.includes(a.id));
  return map.applications.filter((a) => {
    if (!("repo" in a.source)) return here.mapIsLocal;
    const repo = a.source.repo;
    return (
      (here.remote !== undefined && sameRepository(repo, here.remote)) || here.resolve(repo) === here.root
    );
  });
}

/** The impact of changed files of this repository's applications, and of contracts named outright. */
export function impactOf(
  map: SystemMap,
  input: {
    readonly self: readonly Application[];
    readonly files: readonly string[];
    readonly contracts?: readonly string[];
  },
): SystemImpact {
  const reasons = new Map<string, Set<string>>();
  const note = (app: string, why: string) => {
    const set = reasons.get(app) ?? new Set<string>();
    set.add(why);
    reasons.set(app, set);
  };
  const changes = new Map<string, "spec" | "implementation" | "named">();
  const rank = { named: 0, implementation: 1, spec: 2 } as const;
  const mark = (c: Contract, change: "spec" | "implementation" | "named") => {
    const before = changes.get(c.id);
    if (!before || rank[change] > rank[before]) changes.set(c.id, change);
  };
  const owned = (app: string) => map.contracts.filter((c) => c.owner === app);
  const depth = (a: Application) => (appDir(a) === "." ? 0 : appDir(a).split("/").length);
  const unmapped: string[] = [];
  for (const file of input.files) {
    const app = input.self
      .filter((a) => appDir(a) === "." || file === appDir(a) || file.startsWith(`${appDir(a)}/`))
      .sort((x, y) => depth(y) - depth(x))[0];
    if (!app) {
      unmapped.push(file);
      continue;
    }
    note(app.id, `its files changed (${file})`);
    for (const c of owned(app.id))
      mark(c, join(appDir(app), c.spec.path) === file ? "spec" : "implementation");
  }
  for (const id of input.contracts ?? []) {
    const c = map.contracts.find((x) => x.id === id);
    if (c) mark(c, "named");
  }
  const ordered = [...changes.entries()].sort(([a], [b]) => a.localeCompare(b));
  const contracts = ordered.map(([id, change]) => {
    const c = map.contracts.find((x) => x.id === id) as Contract;
    const consumers = map.applications.flatMap((a) =>
      a.consumes
        .map(parseConsumes)
        .filter((p) => p.contract === id)
        .map((p) => ({ app: a.id, ...(p.version ? { version: p.version } : {}) })),
    );
    for (const k of consumers) note(k.app, `consumes ${id}${k.version ? `@${k.version}` : ""} (${change})`);
    note(c.owner, `provides ${id}`);
    return { id, owner: c.owner, change, consumers };
  });
  return {
    applications: map.applications
      .filter((a) => reasons.has(a.id))
      .map((a) => ({
        id: a.id,
        reasons: [...(reasons.get(a.id) ?? [])],
        owners: [...a.owners],
        source: a.source,
      })),
    contracts,
    unmapped: unmapped.sort(),
  };
}

/** The cache directory of a clone: one per repository and commit. */
export function cloneDir(repo: string, sha: string): string {
  const name = repo
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split(/[/:]/)
    .filter(Boolean)
    .slice(-2)
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${name || "repo"}@${sha.slice(0, 12)}`;
}
