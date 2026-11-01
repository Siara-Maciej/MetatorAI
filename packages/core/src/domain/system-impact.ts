import { matchesAny } from "./glob.ts";
import {
  type Application,
  appDir,
  type Contract,
  consumersOf,
  type SystemMap,
  specPath,
} from "./system-map.ts";

/**
 * Where a change lands across the system (F7.3, ADR-0068): from the files a change touches (or the
 * contracts it names) to the contracts whose specification or implementation changed, their
 * consumers and the owners to talk to. Computed from the map; other repositories are read only
 * where their files are needed.
 */
export interface SystemImpact {
  readonly applications: readonly {
    readonly id: string;
    /** Its own files changed (not only through a contract). */
    readonly changed: boolean;
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

/**
 * One repository however it is written: `git@github.com:acme/web.git`, `ssh://git@github.com/acme/web`,
 * `https://bot@github.com/acme/web.git/` and `github.com/acme/web` are the same.
 */
export function sameRepository(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .replace(/^[a-z+]+:\/\//, "")
      .replace(/^[^@/]+@([^:/]+):/, "$1/")
      .replace(/^[^@/]+@/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The applications whose code is in this repository: the configured ones, those whose `repo` is
 * this repository (remote or path), and, when the map itself lives here, those with only a path.
 */
export function selfApplications(
  map: SystemMap,
  here: {
    readonly configured?: readonly string[];
    readonly remote?: string;
    /** This repository's absolute path. */
    readonly root: string;
    readonly mapIsLocal: boolean;
    /** Where a repository written in the map is: an absolute path or a URL. */
    readonly resolve: (repo: string) => string;
  },
): Application[] {
  if (here.configured) return map.applications.filter((a) => here.configured?.includes(a.id));
  return map.applications.filter((a) => {
    if (!("repo" in a.source)) return here.mapIsLocal;
    const repo = a.source.repo;
    const where = here.resolve(repo);
    const remote = here.remote;
    return (
      where === here.root ||
      (remote !== undefined && (sameRepository(repo, remote) || sameRepository(where, remote)))
    );
  });
}

/** The impact of changed files of this repository's applications, and of contracts named outright. */
/**
 * Files MetatorAI itself writes in a repository (its state, canon, cards, map and the host files
 * it generates): a change to them changes no application.
 */
export const METATOR_FILES: readonly string[] = [
  ".metator/**",
  "metator/**",
  "metator.config.yml",
  "metator.config.json",
  "metator.repos.yml",
  "docs/metator/**",
  ".claude/agents/mt-*",
  ".claude/skills/mt-*/**",
  ".github/agents/mt-*",
  ".github/skills/mt-*/**",
  ".github/instructions/mt-*",
  ".github/metator/**",
];

export function impactOf(
  map: SystemMap,
  input: {
    readonly self: readonly Application[];
    readonly files: readonly string[];
    readonly contracts?: readonly string[];
    /** Files that import a file, directly or not: a changed library reaches the apps using it. */
    readonly usedBy?: (file: string) => readonly string[];
  },
): SystemImpact {
  const reasons = new Map<string, Set<string>>();
  const changed = new Set<string>();
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
  const appOf = (file: string) =>
    input.self
      .filter((a) => appDir(a) === "." || file === appDir(a) || file.startsWith(`${appDir(a)}/`))
      .sort((x, y) => depth(y) - depth(x))[0];
  for (const file of input.files) {
    if (matchesAny(file, METATOR_FILES)) continue;
    const app = appOf(file);
    if (app) {
      changed.add(app.id);
      note(app.id, `its files changed (${file})`);
      for (const c of owned(app.id)) mark(c, specPath(app, c) === file ? "spec" : "implementation");
      continue;
    }
    // A file of no application (a library package): the applications whose files import it.
    const users = [...new Set((input.usedBy?.(file) ?? []).map(appOf))].filter(
      (a): a is Application => a !== undefined,
    );
    if (users.length === 0) unmapped.push(file);
    for (const user of users) {
      changed.add(user.id);
      note(user.id, `uses ${file}, which changed`);
      for (const c of owned(user.id)) mark(c, "implementation");
    }
  }
  for (const id of input.contracts ?? []) {
    const c = map.contracts.find((x) => x.id === id);
    if (c) mark(c, "named");
  }
  const ordered = [...changes.entries()].sort(([a], [b]) => a.localeCompare(b));
  const contracts = ordered.map(([id, change]) => {
    const c = map.contracts.find((x) => x.id === id) as Contract;
    const consumers = consumersOf(map, id).map((k) => ({
      app: k.app,
      ...(k.range ? { version: k.range } : {}),
    }));
    for (const k of consumers) note(k.app, `consumes ${id}${k.version ? `@${k.version}` : ""} (${change})`);
    note(c.owner, `provides ${id}`);
    return { id, owner: c.owner, change, consumers };
  });
  return {
    applications: map.applications
      .filter((a) => reasons.has(a.id))
      .map((a) => ({
        id: a.id,
        changed: changed.has(a.id),
        reasons: [...(reasons.get(a.id) ?? [])],
        owners: [...a.owners],
        source: a.source,
      })),
    contracts,
    unmapped: unmapped.sort(),
  };
}

/**
 * A repository written relative to another one's URL: `../billing` next to
 * `https://github.com/acme/platform` is `https://github.com/acme/billing` (also for `git@host:` and
 * `host/path` forms). Undefined when it climbs above the host.
 */
export function relativeRepository(base: string, relative: string): string | undefined {
  const m = /^([a-z+]+:\/\/[^/]+\/|[^@/]+@[^:/]+:|[^/:]+\/)(.*)$/.exec(base.trim());
  if (!m) return undefined;
  const parts = (m[2] ?? "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(segment);
  }
  return `${m[1]}${parts.join("/")}`;
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
