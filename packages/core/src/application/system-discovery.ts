import type { ArchitectureReport } from "../domain/architecture.ts";
import { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import { packageOf } from "../domain/import-index.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  type AppCandidate,
  contractIds,
  type FoundContract,
  type FoundReference,
  kindFrom,
  needlesOf,
  proposeSystem,
  type SystemDiscovery,
  slugId,
  systemDrift,
  type Topology,
} from "../domain/system-discovery.ts";
import type { SystemMap } from "../domain/system-map.ts";
import { SystemMapDocument } from "../domain/system-map.ts";
import { renderYamlDocument } from "../domain/versioned.ts";
import type { ContractDetector, DetectedContract, FileSystem, ManifestReader, Vcs } from "../ports/index.ts";
import type { AnalyzeArchitecture } from "./architecture.ts";
import type { FindOwners } from "./owners.ts";

const SEARCHED = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,yaml,yml,toml,env}", "**/.env*"];
const SKIPPED = [
  "**/node_modules/**",
  ".metator/**",
  "**/dist/**",
  "**/build/**",
  "**/*.lock",
  "**/package-lock.json",
];
const MAX_TEXT = 256 * 1024;

/** One repository's applications, specifications and files, as `system discover` reads them. */
export interface DiscoverySource {
  /** The repository's name (its directory in a folder of repositories). */
  readonly name: string;
  remote(): Promise<string | undefined>;
  applications(): Promise<
    Result<
      readonly {
        readonly name: string;
        readonly dir: string;
        readonly deps: readonly string[];
        readonly signals: readonly string[];
        readonly docker: boolean;
        readonly bin: boolean;
      }[],
      MetatorError
    >
  >;
  specifications(
    detectors: readonly ContractDetector[],
  ): Promise<Result<readonly (DetectedContract & { readonly kind: string })[], MetatorError>>;
  owners(dirs: readonly string[]): Promise<Result<readonly (readonly string[])[], MetatorError>>;
  /** Text files worth searching for references, with their content. */
  texts(): AsyncIterable<{ readonly path: string; readonly text: string }>;
}

/** A repository on this machine, read through its own container's ports. */
export class RepositoryDiscoverySource implements DiscoverySource {
  constructor(
    readonly name: string,
    private readonly vcs: Pick<Vcs, "listFiles" | "remoteUrl">,
    private readonly fs: FileSystem,
    private readonly manifests: ManifestReader,
    private readonly analyze: Pick<AnalyzeArchitecture, "execute">,
    private readonly findOwners: Pick<FindOwners, "execute">,
  ) {}

  async remote(): Promise<string | undefined> {
    const r = await this.vcs.remoteUrl();
    return r.isOk() ? r.value : undefined;
  }

  private async files(): Promise<Result<readonly string[], MetatorError>> {
    const files = await this.vcs.listFiles();
    return files.map((all) => all.filter((f) => !matchesAny(f, SKIPPED)));
  }

  async applications() {
    const manifests = await this.manifests.manifests();
    if (manifests.isErr()) return err(manifests.error);
    const files = await this.files();
    if (files.isErr()) return err(files.error);
    const docker = (dir: string) => files.value.includes(dir === "." ? "Dockerfile" : `${dir}/Dockerfile`);
    const deps = (m: (typeof manifests.value.packages)[number]) => [
      ...Object.keys(m.dependencies),
      ...Object.keys(m.devDependencies),
    ];
    const packages = manifests.value.packages.filter((m) => m.dir !== ".");
    if (packages.length === 0) {
      // One application: the repository itself.
      const root = manifests.value.root;
      return ok([
        {
          name: root?.name && root.name !== "(root)" ? root.name : this.name,
          dir: ".",
          deps: root ? deps(root) : [],
          signals: ["the repository is one application"],
          docker: docker("."),
          bin: root?.bin ?? false,
        },
      ]);
    }
    const analyzed = await this.analyze.execute();
    if (analyzed.isErr()) return err(analyzed.error);
    const report: ArchitectureReport = analyzed.value.report;
    const kinds = new Map(report.packages.map((p) => [p.name, p.kind]));
    return ok(
      packages.flatMap((m) => {
        const signals = [
          ...(kinds.get(m.name) === "app"
            ? [`${m.name} is an application (no package depends on it, it runs on its own)`]
            : []),
          ...(docker(m.dir) ? [`${m.dir}/Dockerfile`] : []),
        ];
        return signals.length > 0
          ? [{ name: m.name, dir: m.dir, deps: deps(m), signals, docker: docker(m.dir), bin: m.bin }]
          : [];
      }),
    );
  }

  async specifications(detectors: readonly ContractDetector[]) {
    const files = await this.files();
    if (files.isErr()) return err(files.error);
    const out: (DetectedContract & { kind: string })[] = [];
    for (const d of detectors)
      for (const path of files.value.filter((f) => matchesAny(f, d.globs))) {
        const text = await this.fs.read(path);
        if (text.isErr() || text.value.length > MAX_TEXT) continue;
        const found = d.detect(path, text.value);
        if (found.isErr()) return err(found.error);
        if (found.value) out.push({ ...found.value, kind: d.kind });
      }
    return ok(out);
  }

  async owners(dirs: readonly string[]) {
    const r = await this.findOwners.execute({
      paths: dirs.map((d) => (d === "." ? "package.json" : `${d}/package.json`)),
    });
    return r.map((o) => o.owners.map((x) => x.owners));
  }

  async *texts() {
    const files = await this.files();
    if (files.isErr()) return;
    for (const path of files.value.filter((f) => matchesAny(f, SEARCHED))) {
      const text = await this.fs.read(path);
      if (text.isOk() && text.value.length <= MAX_TEXT) yield { path, text: text.value };
    }
  }
}

export interface DiscoveredSystem extends SystemDiscovery {
  /** Where the map is, when the place has one; what it lacks that the code shows. */
  readonly map: string | null;
  readonly drift: readonly string[];
  /** Where the proposal was written (`--write`), when it was. */
  readonly written?: string;
}

/**
 * `system discover` (F7.2): applications, contracts and consumers of one repository (a single
 * application or a monorepo) or of a folder of repositories, proposed as a map with evidence.
 */
export class DiscoverSystem {
  constructor(private readonly detectors: readonly ContractDetector[]) {}

  async execute(input: {
    readonly sources: readonly DiscoverySource[];
    readonly system: string;
    /** The map of the place, to compare and (`write`) to create. */
    readonly map?: {
      readonly file: string;
      readonly load: () => Promise<Result<SystemMap | undefined, MetatorError>>;
      readonly fs: FileSystem;
    };
    readonly write?: boolean;
  }): Promise<Result<DiscoveredSystem, MetatorError>> {
    const folder = input.sources.length > 1;
    const apps: (AppCandidate & { readonly sourceIndex: number; readonly dir: string })[] = [];
    const contracts: (FoundContract & { readonly sourceIndex: number; readonly file: string })[] = [];
    const taken = new Set<string>();
    for (const [i, source] of input.sources.entries()) {
      const found = await source.applications();
      if (found.isErr()) return err(found.error);
      const specs = await source.specifications(this.detectors);
      if (specs.isErr()) return err(specs.error);
      const owners = await source.owners(found.value.map((a) => a.dir));
      if (owners.isErr()) return err(owners.error);
      const remote = folder ? await source.remote() : undefined;
      const refs = found.value.map((a) => ({ name: a.name, dir: a.dir }));
      for (const [j, a] of found.value.entries()) {
        let id = slugId(a.dir === "." && folder ? source.name : a.name);
        if (taken.has(id)) id = `${slugId(source.name)}-${id}`;
        taken.add(id);
        const hasSpec = specs.value.some((s) => packageOf(s.path, refs)?.dir === a.dir);
        apps.push({
          id,
          sourceIndex: i,
          dir: a.dir,
          source: folder
            ? { repo: remote ?? source.name, ...(a.dir === "." ? {} : { path: a.dir }) }
            : { path: a.dir },
          kind: kindFrom(a.name, a.deps, hasSpec, a.bin),
          owners: owners.value[j] ?? [],
          ...(a.docker ? { deployUnit: id } : {}),
          signals: a.signals,
        });
      }
      for (const s of specs.value) {
        const owner = packageOf(s.path, refs);
        const app = owner ? apps.find((x) => x.sourceIndex === i && x.dir === owner.dir) : undefined;
        if (!app) continue; // a specification outside every application has no provider
        contracts.push({
          app: app.id,
          sourceIndex: i,
          file: s.path,
          kind: s.kind,
          spec: app.dir === "." ? s.path : s.path.slice(app.dir.length + 1),
          title: s.title,
          ...(s.version ? { version: s.version } : {}),
          servers: s.servers,
        });
      }
    }
    const ids = contractIds(contracts);

    // Consumers: another application's files that point at a contract.
    const references: FoundReference[] = [];
    const seen = new Set<string>();
    for (const [i, source] of input.sources.entries()) {
      const mine = apps.filter((a) => a.sourceIndex === i);
      const refs = mine.map((a) => ({ name: a.id, dir: a.dir }));
      for await (const { path, text } of source.texts()) {
        const from = packageOf(path, refs)?.name;
        if (!from) continue;
        for (const c of contracts) {
          if (c.app === from) continue;
          const provider = apps.find((a) => a.id === c.app);
          const dir =
            provider?.dir === "." && folder
              ? (input.sources[provider.sourceIndex]?.name ?? ".")
              : (provider?.dir ?? ".");
          for (const n of needlesOf(c, dir)) {
            const key = `${from}\u0000${ids.get(c)}\u0000${n.reason}`;
            if (seen.has(key) || !text.includes(n.text)) continue;
            seen.add(key);
            references.push({
              from,
              contract: ids.get(c) as string,
              file: folder ? `${source.name}/${path}` : path,
              reason: n.reason,
              confidence: n.confidence,
            });
          }
        }
      }
    }
    const topology: Topology = folder ? "repos" : apps.length > 1 ? "monorepo" : "single";
    const discovery = proposeSystem({
      system: slugId(input.system),
      topology,
      apps,
      contracts,
      references,
      ids,
    });

    let drift: string[] = [];
    let written: string | undefined;
    if (input.map) {
      const existing = await input.map.load();
      if (existing.isErr()) return err(existing.error);
      if (existing.value) drift = systemDrift(existing.value, discovery.proposal);
      else if (input.write) {
        const doc = SystemMapDocument.stamp(discovery.proposal);
        const saved = await input.map.fs.write(
          input.map.file,
          renderYamlDocument(
            { ...doc } as typeof doc & Record<string, unknown>,
            "Proposed by `metator system discover`: check the applications, contracts and consumers, then commit.",
          ),
        );
        if (saved.isErr()) return err(saved.error);
        written = input.map.file;
      }
      if (input.write && existing.value)
        return err(
          MetatorError.usage(
            `${input.map.file} already exists`,
            "`system discover` never overwrites the map; `--check` shows what it lacks.",
          ),
        );
    }
    return ok({ ...discovery, map: input.map?.file ?? null, drift, ...(written ? { written } : {}) });
  }
}
