import type { SystemSettings } from "../domain/config.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { appDir, cloneDir, impactOf, type SystemImpact, selfApplications } from "../domain/system-impact.ts";
import { type Application, type SystemMap, SystemMapDocument } from "../domain/system-map.ts";
import { parseYamlDocument } from "../domain/versioned.ts";
import type { CheckoutReader, RepositoryCloner, Vcs } from "../ports/index.ts";

/** Where the system map is: this repository, or a platform repository at a pinned commit. */
export interface SystemLocation {
  readonly source: string;
  /** True when the map is a file of this repository. */
  readonly local: boolean;
  load(): Promise<Result<SystemMap | undefined, MetatorError>>;
  /** The checkout the map is read from: its `path` applications live there. */
  root(): Promise<Result<string, MetatorError>>;
  /** Where the map's relative repositories (`../billing`) start: the map repository's own place. */
  repoBase(): Promise<Result<string, MetatorError>>;
}

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

/** A map file of this repository, as `SystemCatalog` reads it. */
export interface MapFile {
  readonly source: string;
  load(): Promise<Result<SystemMap | undefined, MetatorError>>;
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

  async root() {
    return ok(this.here);
  }

  async repoBase() {
    return ok(this.here);
  }
}

/** The map in another repository at `ref` (`system.map: { repo, ref, path }`), from the clone cache. */
export class PinnedSystemLocation implements SystemLocation {
  readonly local = false;
  constructor(
    private readonly map: { readonly repo: string; readonly ref?: string; readonly path: string },
    private readonly here: string,
    private readonly cache: string,
    private readonly cloner: RepositoryCloner,
    private readonly reader: CheckoutReader,
  ) {}

  get source(): string {
    return `${this.map.repo}@${this.map.ref ?? "HEAD"}:${this.map.path}`;
  }

  private repo(): string {
    return isPath(this.map.repo) ? absolute(this.here, this.map.repo) : this.map.repo;
  }

  async root(): Promise<Result<string, MetatorError>> {
    const sha = await this.cloner.resolve(this.repo(), this.map.ref);
    if (sha.isErr()) return err(sha.error);
    const dir = `${this.cache}/${cloneDir(this.map.repo, sha.value)}`;
    const done = await this.cloner.checkout(this.repo(), sha.value, dir);
    return done.isErr() ? err(done.error) : ok(dir);
  }

  async repoBase(): Promise<Result<string, MetatorError>> {
    return isPath(this.map.repo) ? ok(this.repo()) : this.root();
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
  readonly via: "here" | "map" | "local" | "clone";
}

/** Where each application's code is on this machine: a configured checkout, a path, or a clone. */
export class SystemSources {
  constructor(
    private readonly settings: SystemSettings | undefined,
    private readonly here: string,
    private readonly cache: string,
    private readonly cloner: RepositoryCloner,
    private readonly reader: CheckoutReader,
  ) {}

  async locate(
    app: Application,
    location: Pick<SystemLocation, "local" | "root" | "repoBase">,
    options: { readonly fetch?: boolean } = {},
  ): Promise<Result<LocatedSource | undefined, MetatorError>> {
    const dir = appDir(app);
    const configured = this.settings?.roots[app.id];
    if (configured) {
      const root = absolute(this.here, configured);
      if (await this.reader.isDirectory(root)) return ok({ app: app.id, root, dir, via: "local" });
    }
    const mapRoot = await location.root();
    if (mapRoot.isErr()) return err(mapRoot.error);
    if (!("repo" in app.source))
      return ok({ app: app.id, root: mapRoot.value, dir, via: location.local ? "here" : "map" });
    const { repo, ref } = app.source;
    if (isPath(repo)) {
      const base = await location.repoBase();
      if (base.isErr()) return err(base.error);
      const root = absolute(base.value, repo);
      if (!ref && (await this.reader.isDirectory(root))) return ok({ app: app.id, root, dir, via: "local" });
      if (!options.fetch) return ok(undefined);
      return this.clone(app.id, root, ref, dir);
    }
    return options.fetch ? this.clone(app.id, repo, ref, dir) : ok(undefined);
  }

  private async clone(app: string, repo: string, ref: string | undefined, dir: string) {
    const sha = await this.cloner.resolve(repo, ref);
    if (sha.isErr()) return err(sha.error);
    const root = `${this.cache}/${cloneDir(repo, sha.value)}`;
    const done = await this.cloner.checkout(repo, sha.value, root);
    if (done.isErr()) return err(done.error);
    return ok({ app, root, dir, via: "clone" as const });
  }
}

/** The applications of the map whose code is this repository (`system.self`, its remote or its path). */
export async function selfOf(
  map: SystemMap,
  location: Pick<SystemLocation, "local" | "repoBase">,
  vcs: Pick<Vcs, "remoteUrl">,
  settings: SystemSettings | undefined,
  here: string,
): Promise<Result<Application[], MetatorError>> {
  const remote = await vcs.remoteUrl();
  const base = await location.repoBase();
  if (base.isErr()) return err(base.error);
  return ok(
    selfApplications(map, {
      ...(settings?.self ? { configured: settings.self } : {}),
      ...(remote.isOk() && remote.value ? { remote: remote.value } : {}),
      root: here,
      mapIsLocal: location.local,
      resolve: (repo) => (isPath(repo) ? absolute(base.value, repo) : repo),
    }),
  );
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
    private readonly location: SystemLocation,
    private readonly vcs: Pick<Vcs, "changedFiles" | "remoteUrl">,
    private readonly settings: SystemSettings | undefined,
    private readonly here: string,
  ) {}

  async execute(input: {
    readonly base?: string;
    readonly files?: readonly string[];
    readonly contracts?: readonly string[];
  }): Promise<Result<SystemImpactReport, MetatorError>> {
    const map = await this.location.load();
    if (map.isErr()) return err(map.error);
    if (!map.value)
      return err(
        MetatorError.notFound(`a system map at ${this.location.source}`, {
          hint: "`metator system discover --write` proposes one; `system.map` in metator.config points to another repository's.",
        }),
      );
    const unknown = (input.contracts ?? []).filter((c) => !map.value?.contracts.some((x) => x.id === c));
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
    const self = await selfOf(map.value, this.location, this.vcs, this.settings, this.here);
    if (self.isErr()) return err(self.error);
    const impact = impactOf(map.value, {
      self: self.value,
      files,
      ...(input.contracts ? { contracts: input.contracts } : {}),
    });
    return ok({
      map: this.location.source,
      self: self.value.map((a) => a.id),
      base: input.files ? null : (input.base ?? null),
      ...impact,
    });
  }
}
