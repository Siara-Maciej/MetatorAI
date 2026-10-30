import type { SystemSettings } from "../domain/config.ts";
import { MetatorError } from "../domain/errors.ts";
import { DependencyGraph } from "../domain/graph.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  cloneDir,
  impactOf,
  relativeRepository,
  type SystemImpact,
  sameRepository,
  selfApplications,
} from "../domain/system-impact.ts";
import { type Application, appDir, type SystemMap, SystemMapDocument } from "../domain/system-map.ts";
import { parseYamlDocument } from "../domain/versioned.ts";
import type { CheckoutReader, ImportGraphReader, RepositoryCloner, Vcs } from "../ports/index.ts";

/** `path` resolved against an absolute `base`, with `.` and `..` taken out. */
export function absolute(base: string, path: string): string {
  const parts: string[] = [];
  for (const segment of (path.startsWith("/") ? path : `${base}/${path}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/** A path written as a repository (`../billing`, `/src/billing`) rather than a URL. */
const isPath = (repo: string) => repo.startsWith(".") || repo.startsWith("/");

const NO_MAP_HINT =
  "`metator system discover --write` proposes one; `system.map` in metator.config points to another repository's.";

/** Where the system map is: this repository, or a platform repository at a pinned commit. */
export interface SystemLocation {
  readonly source: string;
  /** True when the map is a file of this repository. */
  readonly local: boolean;
  load(): Promise<Result<SystemMap | undefined, MetatorError>>;
  /** The map, or NOT_FOUND with how to make one. */
  require(): Promise<Result<SystemMap, MetatorError>>;
  /** The checkout the map is read from: its `path` applications live there. */
  root(): Promise<Result<string, MetatorError>>;
  /** Where a repository the map names is: an absolute path, or a URL to clone. */
  resolveRepo(repo: string): Result<string, MetatorError>;
}

/** A map file of this repository, as `SystemCatalog` reads it. */
export interface MapFile {
  readonly source: string;
  load(): Promise<Result<SystemMap | undefined, MetatorError>>;
}

async function required(location: Pick<SystemLocation, "load" | "source">) {
  const map = await location.load();
  if (map.isErr()) return err(map.error);
  return map.value
    ? ok(map.value)
    : err(MetatorError.notFound(`a system map at ${location.source}`, { hint: NO_MAP_HINT }));
}

/**
 * Clones in `.metator/system/<repo>@<sha>`: a ref is resolved once per command (so the map and
 * every specification are read at one commit), and each commit is cloned once.
 */
export class CloneCache {
  private readonly shas = new Map<string, Promise<Result<string, MetatorError>>>();

  constructor(
    private readonly cloner: RepositoryCloner,
    private readonly dir: string,
  ) {}

  async at(repo: string, ref?: string): Promise<Result<string, MetatorError>> {
    const key = `${repo}\u0000${ref ?? ""}`;
    let sha = this.shas.get(key);
    if (!sha) {
      sha = this.cloner.resolve(repo, ref);
      this.shas.set(key, sha);
    }
    const resolved = await sha;
    if (resolved.isErr()) return err(resolved.error);
    const target = `${this.dir}/${cloneDir(repo, resolved.value)}`;
    const done = await this.cloner.checkout(repo, resolved.value, target);
    return done.isErr() ? err(done.error) : ok(target);
  }
}

/** The map in this repository (`docs/metator/system.yml` or `system.map.path`). */
export class LocalSystemLocation implements SystemLocation {
  readonly local = true;
  constructor(
    private readonly catalog: MapFile,
    private readonly here: string,
  ) {}

  get source(): string {
    return this.catalog.source;
  }

  load() {
    return this.catalog.load();
  }

  require() {
    return required(this);
  }

  async root() {
    return ok(this.here);
  }

  resolveRepo(repo: string): Result<string, MetatorError> {
    return ok(isPath(repo) ? absolute(this.here, repo) : repo);
  }
}

/** The map in another repository at `ref` (`system.map: { repo, ref, path }`), from the clone cache. */
export class PinnedSystemLocation implements SystemLocation {
  readonly local = false;
  constructor(
    private readonly map: { readonly repo: string; readonly ref?: string; readonly path: string },
    private readonly here: string,
    private readonly clones: Pick<CloneCache, "at">,
    private readonly reader: Pick<CheckoutReader, "read">,
  ) {}

  get source(): string {
    return `${this.map.repo}@${this.map.ref ?? "HEAD"}:${this.map.path}`;
  }

  /** The platform repository itself: a path from here, or its URL. */
  private platform(): string {
    return isPath(this.map.repo) ? absolute(this.here, this.map.repo) : this.map.repo;
  }

  root(): Promise<Result<string, MetatorError>> {
    return this.clones.at(this.platform(), this.map.ref);
  }

  /** Relative repositories (`../billing`) start where the platform repository really is, not in its clone. */
  resolveRepo(repo: string): Result<string, MetatorError> {
    if (!isPath(repo)) return ok(repo);
    const platform = this.platform();
    if (isPath(this.map.repo)) return ok(absolute(platform, repo));
    const url = relativeRepository(platform, repo);
    return url
      ? ok(url)
      : err(
          MetatorError.usage(`${repo} climbs above ${platform}`, "Write the repository as a URL in the map."),
        );
  }

  require() {
    return required(this);
  }

  async load(): Promise<Result<SystemMap | undefined, MetatorError>> {
    const root = await this.root();
    if (root.isErr()) return err(root.error);
    const text = await this.reader.read(root.value, this.map.path);
    if (text.isErr()) return err(text.error);
    if (text.value === undefined)
      return err(
        MetatorError.notFound(`the system map ${this.map.path} in ${this.map.repo}`, { source: this.source }),
      );
    return parseYamlDocument(text.value, this.source).andThen((raw) =>
      SystemMapDocument.parse(raw, this.source),
    );
  }
}

export interface LocatedSource {
  readonly app: string;
  /** Where its code is on this machine. */
  readonly root: string;
  readonly dir: string;
  /** here: this repository; map: the map's checkout; local: a checkout set or found; clone: the cache. */
  readonly via: "here" | "map" | "local" | "clone";
}

/**
 * Where each application's code is on this machine, and which applications this repository is:
 * a configured checkout (`system.roots`), this repository, a path checkout, or a clone with `fetch`.
 */
export class SystemSources {
  private remote?: Promise<string | undefined>;

  constructor(
    private readonly settings: SystemSettings | undefined,
    private readonly here: string,
    readonly location: SystemLocation,
    private readonly clones: Pick<CloneCache, "at">,
    private readonly reader: Pick<CheckoutReader, "isDirectory" | "read">,
    private readonly vcs: Pick<Vcs, "remoteUrl">,
  ) {}

  private origin(): Promise<string | undefined> {
    this.remote ??= this.vcs.remoteUrl().then((r) => (r.isOk() ? r.value : undefined));
    return this.remote;
  }

  /** The applications of the map whose code is this repository (`system.self`, its remote or its path). */
  async self(map: SystemMap): Promise<Result<Application[], MetatorError>> {
    const resolved = new Map<string, string>();
    for (const a of map.applications)
      if ("repo" in a.source) {
        const where = this.location.resolveRepo(a.source.repo);
        if (where.isErr()) return err(where.error);
        resolved.set(a.source.repo, where.value);
      }
    const remote = await this.origin();
    return ok(
      selfApplications(map, {
        ...(this.settings?.self ? { configured: this.settings.self } : {}),
        ...(remote ? { remote } : {}),
        root: this.here,
        mapIsLocal: this.location.local,
        resolve: (repo) => resolved.get(repo) ?? repo,
      }),
    );
  }

  async locate(
    app: Application,
    options: { readonly fetch?: boolean } = {},
  ): Promise<Result<LocatedSource | undefined, MetatorError>> {
    const dir = appDir(app);
    const configured = this.settings?.roots[app.id];
    if (configured) {
      const root = absolute(this.here, configured);
      if (await this.reader.isDirectory(root)) return ok({ app: app.id, root, dir, via: "local" });
    }
    if (!("repo" in app.source)) {
      const mapRoot = await this.location.root();
      if (mapRoot.isErr()) return err(mapRoot.error);
      return ok({ app: app.id, root: mapRoot.value, dir, via: this.location.local ? "here" : "map" });
    }
    const { repo, ref } = app.source;
    const where = this.location.resolveRepo(repo);
    if (where.isErr()) return err(where.error);
    // This repository, however the map names it (its path or its remote): the same test as `self`.
    const remote = await this.origin();
    const isRemote = remote !== undefined && [repo, where.value].some((r) => sameRepository(r, remote));
    if (where.value === this.here || isRemote) return ok({ app: app.id, root: this.here, dir, via: "here" });
    if (where.value.startsWith("/") && !ref && (await this.reader.isDirectory(where.value)))
      return ok({ app: app.id, root: where.value, dir, via: "local" });
    // Repositories cloned side by side: a sibling named like the repository, with its remote. A
    // pinned ref is a commit, not a working tree, so it is still cloned.
    if (!ref) {
      const sibling = await this.sibling(repo);
      if (sibling) return ok({ app: app.id, root: sibling, dir, via: "local" });
    }
    if (!options.fetch) return ok(undefined);
    const cloned = await this.clones.at(where.value, ref);
    return cloned.isErr() ? err(cloned.error) : ok({ app: app.id, root: cloned.value, dir, via: "clone" });
  }

  /** `../<name>` next to this repository when its git remote is `repo`. */
  private async sibling(repo: string): Promise<string | undefined> {
    const name = repo
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .at(-1);
    if (!name || name === "." || name === "..") return undefined;
    const candidate = `${this.here.replace(/\/[^/]+\/?$/, "")}/${name}`;
    if (candidate === this.here || !(await this.reader.isDirectory(candidate))) return undefined;
    const config = await this.reader.read(candidate, ".git/config");
    if (config.isErr() || config.value === undefined) return undefined;
    const urls = [...config.value.matchAll(/^\s*url\s*=\s*(\S+)/gm)].map((m) => m[1] as string);
    return urls.some((u) => sameRepository(u, repo)) ? candidate : undefined;
  }

  /** Every application of the map, located (`system sources`). */
  async locateAll(
    options: { readonly fetch?: boolean } = {},
  ): Promise<
    Result<
      { readonly map: string; readonly sources: readonly (LocatedSource | { app: string; via: "none" })[] },
      MetatorError
    >
  > {
    const map = await this.location.require();
    if (map.isErr()) return err(map.error);
    const sources: (LocatedSource | { app: string; via: "none" })[] = [];
    for (const app of map.value.applications) {
      const at = await this.locate(app, options);
      if (at.isErr()) return err(at.error);
      sources.push(at.value ?? { app: app.id, via: "none" });
    }
    return ok({ map: this.location.source, sources });
  }
}

export interface SystemImpactReport extends SystemImpact {
  readonly map: string;
  /** The applications this repository is. */
  readonly self: readonly string[];
  readonly base: string | null;
}

/**
 * `system impact` (F7.3): the changed files of this repository (since `--base`, or `--files`) and
 * the contracts named (`--contracts`), through the map, to contracts, consumers and owners.
 */
export class SystemImpactQuery {
  constructor(
    private readonly sources: Pick<SystemSources, "self" | "location">,
    private readonly vcs: Pick<Vcs, "changedFiles">,
    /** The import graph: a changed library reaches the applications that import it. */
    private readonly graph?: ImportGraphReader,
  ) {}

  async execute(input: {
    readonly base?: string;
    readonly files?: readonly string[];
    readonly contracts?: readonly string[];
  }): Promise<Result<SystemImpactReport, MetatorError>> {
    const map = await this.sources.location.require();
    if (map.isErr()) return err(map.error);
    const unknown = (input.contracts ?? []).filter((c) => !map.value.contracts.some((x) => x.id === c));
    if (unknown.length > 0)
      return err(
        MetatorError.usage(
          `unknown contract ${unknown.join(", ")}`,
          `Contracts: ${map.value.contracts.map((c) => c.id).join(", ")}.`,
        ),
      );
    let files = input.files ?? [];
    if (!input.files && input.base !== undefined) {
      const changed = await this.vcs.changedFiles(input.base);
      if (changed.isErr()) return err(changed.error);
      files = changed.value;
    }
    const self = await this.sources.self(map.value);
    if (self.isErr()) return err(self.error);
    let usedBy: ((file: string) => readonly string[]) | undefined;
    if (this.graph && files.length > 0) {
      const edges = await this.graph.read();
      if (edges.isErr()) return err(edges.error);
      const deps = new DependencyGraph(edges.value);
      usedBy = (file) => [...deps.affected([file])].filter((f) => f !== file);
    }
    const impact = impactOf(map.value, {
      self: self.value,
      files,
      ...(usedBy ? { usedBy } : {}),
      ...(input.contracts ? { contracts: input.contracts } : {}),
    });
    return ok({
      map: this.sources.location.source,
      self: self.value.map((a) => a.id),
      base: input.files ? null : (input.base ?? null),
      ...impact,
    });
  }
}
