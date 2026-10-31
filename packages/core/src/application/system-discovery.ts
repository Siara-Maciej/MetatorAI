import { analyzeArchitecture } from "../domain/architecture.ts";
import { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import { SECRET_GLOBS } from "../domain/hook.ts";
import { packageOf } from "../domain/import-index.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  type AppCandidate,
  apiRoutes,
  calledRoutes,
  contractIds,
  type DiscoveryEvidence,
  type FoundContract,
  type FoundReference,
  fetchesServed,
  kindFrom,
  needlesOf,
  proposeSystem,
  type ServedSpec,
  type SystemDiscovery,
  servedSpecs,
  slugId,
  systemDrift,
  type Topology,
} from "../domain/system-discovery.ts";
import type { SystemMap } from "../domain/system-map.ts";
import { SystemMapDocument } from "../domain/system-map.ts";
import { renderYamlDocument } from "../domain/versioned.ts";
import type { ContractDetector, DetectedContract, FileSystem, ManifestReader, Vcs } from "../ports/index.ts";
import type { ArchitectureFacts } from "./architecture.ts";
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
  /** Every workspace package with the workspace packages it depends on, to place a library's files. */
  packages(): Promise<
    Result<
      readonly { readonly name: string; readonly dir: string; readonly deps: readonly string[] }[],
      MetatorError
    >
  >;
  /** Text files worth searching for references, with their content. */
  texts(): AsyncIterable<{ readonly path: string; readonly text: string }>;
}

/** Library package → the applications that depend on it, directly or through other libraries. */
function librariesUsedBy(
  packages: readonly { readonly name: string; readonly dir: string; readonly deps: readonly string[] }[],
  apps: readonly { readonly id: string; readonly dir: string }[],
): Map<string, string[]> {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const out = new Map<string, string[]>();
  for (const app of apps) {
    const own = packages.find((p) => p.dir === app.dir);
    const stack = [...(own?.deps ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const name = stack.pop() as string;
      const lib = byName.get(name);
      if (!lib || seen.has(name) || lib.dir === app.dir) continue;
      seen.add(name);
      out.set(name, [...(out.get(name) ?? []), app.id]);
      stack.push(...lib.deps);
    }
  }
  return out;
}

/** A repository on this machine, read through its own container's ports. */
export class RepositoryDiscoverySource implements DiscoverySource {
  constructor(
    readonly name: string,
    private readonly vcs: Pick<Vcs, "listFiles" | "remoteUrl">,
    private readonly fs: FileSystem,
    private readonly manifests: ManifestReader,
    /** The architecture's facts: discovery reads package kinds and writes no report. */
    private readonly facts: Pick<ArchitectureFacts, "gather">,
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
    const facts = await this.facts.gather();
    if (facts.isErr()) return err(facts.error);
    const report = analyzeArchitecture(facts.value);
    const kinds = new Map(report.packages.map((p) => [p.name, p.kind]));
    // The root with a Dockerfile of its own is an application too (an app with a few library
    // packages beside it), not just the workspace that holds them.
    const root = manifests.value.root;
    const rootApp =
      root && docker(".")
        ? [
            {
              name: root.name && root.name !== "(root)" ? root.name : this.name,
              dir: ".",
              deps: deps(root),
              signals: ["Dockerfile at the root: the repository itself is deployed"],
              docker: true,
              bin: root.bin ?? false,
            },
          ]
        : [];
    return ok([
      ...rootApp,
      ...packages.flatMap((m) => {
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
    ]);
  }

  async packages() {
    const manifests = await this.manifests.manifests();
    if (manifests.isErr()) return err(manifests.error);
    return ok(
      manifests.value.packages.map((m) => ({
        name: m.name,
        dir: m.dir,
        deps: [...Object.keys(m.dependencies), ...Object.keys(m.devDependencies)],
      })),
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
    // Never a secret (a real `.env`, keys), tracked or not: the same line the guard draws for agents.
    for (const path of files.value.filter((f) => matchesAny(f, SEARCHED) && !matchesAny(f, SECRET_GLOBS))) {
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
    // Documents served at runtime, and the files that may fetch one (kept small: only those
    // that mention a `-json` URL), matched once every application's files have been read.
    const served: { app: string; file: string; spec: ServedSpec }[] = [];
    const fetching: { from: string; file: string; text: string }[] = [];
    // Routes each application serves, and the routes each calls with a hand-written HTTP client.
    const serves = new Map<string, Set<string>>();
    const calls = new Map<string, { routes: Set<string>; file: string }>();
    for (const [i, source] of input.sources.entries()) {
      const mine = apps.filter((a) => a.sourceIndex === i);
      const refs = mine.map((a) => ({ name: a.id, dir: a.dir }));
      const packages = await source.packages();
      if (packages.isErr()) return err(packages.error);
      const usedBy = librariesUsedBy(packages.value, mine);
      const libs = packages.value.filter((p) => p.dir !== ".").map((p) => ({ name: p.name, dir: p.dir }));
      for await (const { path, text } of source.texts()) {
        const app = packageOf(path, refs)?.name;
        // A library's file speaks for the applications that depend on it (an API client package).
        const froms = app ? [app] : (usedBy.get(packageOf(path, libs)?.name ?? "") ?? []);
        const file = folder ? `${source.name}/${path}` : path;
        for (const from of froms) {
          for (const spec of servedSpecs(text)) served.push({ app: from, file, spec });
          if (text.includes("-json")) fetching.push({ from, file, text });
          for (const r of apiRoutes(text)) serves.set(from, (serves.get(from) ?? new Set()).add(r));
          const called = calledRoutes(text);
          if (called.length > 0) {
            const seen = calls.get(from) ?? { routes: new Set<string>(), file };
            for (const r of called) seen.routes.add(r);
            calls.set(from, seen);
          }
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
    }
    const topology: Topology = folder ? "repos" : apps.length > 1 ? "monorepo" : "single";
    const proposed = proposeSystem({
      system: slugId(input.system),
      topology,
      apps,
      contracts,
      references,
      ids,
    });
    // A document served at runtime is a contract too (ADR-0076): it has an owner and consumers,
    // only no file that `contract diff` could compare.
    const runtime: DiscoveryEvidence[] = [];
    const servedContracts: SystemMap["contracts"] = [];
    const servedConsumers = new Map<string, Set<string>>();
    const usedIds = new Set(proposed.proposal.contracts.map((c) => c.id));
    for (const { app, file, spec } of served) {
      // An application that declares its OpenAPI file serves that document: it is shown, not doubled.
      if (proposed.proposal.contracts.some((c) => c.owner === app && c.kind === "openapi")) {
        runtime.push({
          subject: `served:${app} ${spec.url}`,
          reason: `${spec.framework} serves an OpenAPI document at ${spec.url}; ${app} already declares an OpenAPI file, most likely the same document`,
          file: `${file}:${spec.line}`,
          confidence: "medium",
          proposed: false,
        });
        for (const f of fetching)
          if (f.from !== app && fetchesServed(f.text, spec.url))
            runtime.push({
              subject: `consumes:${f.from}→${app} ${spec.url}`,
              reason: `fetches ${spec.url}, the document ${app} serves`,
              file: f.file,
              confidence: "medium",
              proposed: false,
            });
        continue;
      }
      let id = slugId(`${app}-api`);
      for (let n = 2; usedIds.has(id); n++) id = slugId(`${app}-api-${n}`);
      usedIds.add(id);
      servedContracts.push({
        id,
        kind: "openapi",
        owner: app,
        spec: { served: spec.url },
        compatibility: "backward",
      });
      runtime.push({
        subject: `contract:${id}`,
        reason: `${spec.framework} serves an OpenAPI document at ${spec.url}: a contract with no file to compare (export it to one for \`contract diff\`)`,
        file: `${file}:${spec.line}`,
        confidence: "high",
        proposed: true,
      });
      for (const f of fetching)
        if (f.from !== app && fetchesServed(f.text, spec.url)) {
          servedConsumers.set(f.from, (servedConsumers.get(f.from) ?? new Set()).add(id));
          runtime.push({
            subject: `consumes:${f.from}→${id}`,
            reason: `fetches ${spec.url}, the document ${app} serves`,
            file: f.file,
            confidence: "medium",
            proposed: true,
          });
        }
    }
    const proposal: SystemMap = {
      ...proposed.proposal,
      contracts: [...proposed.proposal.contracts, ...servedContracts],
      applications: proposed.proposal.applications.map((a) => {
        const more = [...(servedConsumers.get(a.id) ?? [])].filter((c) => !a.consumes.includes(c));
        return more.length > 0 ? { ...a, consumes: [...a.consumes, ...more].sort() } : a;
      }),
    };
    // A hand-written client names no spec: it consumes an API when it calls two or more of the
    // routes that application serves.
    const byRoutes: DiscoveryEvidence[] = [];
    const withCalls = proposal.applications.map((a) => {
      const called = calls.get(a.id);
      if (!called) return a;
      const more: string[] = [];
      for (const c of proposal.contracts) {
        if (c.kind !== "openapi" || c.owner === a.id || a.consumes.includes(c.id)) continue;
        const shared = [...called.routes].filter((r) => serves.get(c.owner)?.has(r));
        if (shared.length < 2) continue;
        more.push(c.id);
        byRoutes.push({
          subject: `consumes:${a.id}→${c.id}`,
          reason: `calls routes ${c.owner} serves (${shared.map((r) => `/${r}`).join(", ")}) with an HTTP client`,
          file: called.file,
          confidence: "medium",
          proposed: true,
        });
      }
      return more.length > 0 ? { ...a, consumes: [...a.consumes, ...more].sort() } : a;
    });
    const discovery = {
      ...proposed,
      proposal: { ...proposal, applications: withCalls },
      evidence: [...proposed.evidence, ...runtime, ...byRoutes],
    };

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
