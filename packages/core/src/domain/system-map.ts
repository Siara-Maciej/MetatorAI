import { alg, Graph } from "@dagrejs/graphlib";
import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * The system landscape (`SystemMap`, ADR-0047, design/08): the applications that are deployed on
 * their own, the contracts between them and the policies for changing them. Lets an agent see
 * where a change lands across applications, through which contract, in which order.
 */
const id = z.string().regex(/^[a-z][a-z0-9-]*$/, "use lowercase letters, digits and dashes");

/** Where an application's code is: a directory in this repository, or another repository. */
const SourceSchema = z.union([
  z.strictObject({ path: z.string().min(1) }),
  z.strictObject({
    repo: z.string().min(1),
    /** A pinned commit, tag or branch; without it the default branch. */
    ref: z.string().min(1).optional(),
    /** The application's directory inside that repository. */
    path: z.string().min(1).optional(),
  }),
]);

/** `billing-api` or `billing-api@^2` (the version range the consumer expects). */
const ConsumesSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(@\S+)?$/, "expected <contract> or <contract>@<version range>");

const ApplicationSchema = z.strictObject({
  id,
  kind: z.enum(["frontend", "service", "worker", "gateway", "library", "other"]).default("service"),
  source: SourceSchema,
  owners: z.array(z.string().min(1)).default([]),
  deploy: z
    .strictObject({
      unit: z.string().min(1).optional(),
      environments: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  consumes: z.array(ConsumesSchema).default([]),
});

const compatibility = z.enum(["backward", "forward", "full", "none"]).default("backward");

/** v1: the specification is a file. Never change it (MT-CODE-003). */
const ContractSchemaV1 = z.strictObject({
  id,
  /** A contract kind a plugin provides (MVP: `openapi`). */
  kind: z.string().min(1),
  /** The application that provides it. */
  owner: id,
  /** The specification file, relative to the owner's source. */
  spec: z.strictObject({ path: z.string().min(1) }),
  compatibility,
});

/**
 * v2 (ADR-0076): the specification is a file, or the provider serves it at runtime
 * (`served: /docs-json`, a NestJS app): such a contract has consumers and an owner, but no file
 * that `contract diff` could compare.
 */
const ContractSchema = ContractSchemaV1.extend({
  spec: z.union([
    z.strictObject({ path: z.string().min(1) }),
    z.strictObject({ served: z.string().regex(/^\//, "a path the provider serves, e.g. /docs-json") }),
  ]),
});

const policies = z
  .strictObject({
    /** providers-first: an application deploys after the providers of what it consumes. */
    deployOrder: z.enum(["providers-first", "none"]).default("providers-first"),
    /** How a breaking contract change is introduced. */
    breaking: z.enum(["expand-contract", "versioned", "forbidden"]).default("expand-contract"),
  })
  .default({ deployOrder: "providers-first", breaking: "expand-contract" });

const SystemMapV1Schema = z.strictObject({
  system: id,
  applications: z.array(ApplicationSchema).min(1, "a system has at least one application"),
  contracts: z.array(ContractSchemaV1).default([]),
  policies,
});

export const SystemMapSchema = SystemMapV1Schema.extend({
  contracts: z.array(ContractSchema).default([]),
});
export type SystemMap = z.output<typeof SystemMapSchema>;
export type Application = SystemMap["applications"][number];
export type Contract = SystemMap["contracts"][number];

export const SystemMapDocument = defineDocument("SystemMap", {
  history: [{ schema: SystemMapV1Schema }],
  latest: SystemMapSchema,
  // A v1 contract's file is a v2 contract's file: nothing to migrate.
  upgrade: (previous) => previous,
  errorCode: "INVALID_CONFIG",
  hint: "Fix the listed issues; `metator system schema` prints the JSON Schema.",
});

export function parseConsumes(entry: string): { readonly contract: string; readonly version?: string } {
  const at = entry.indexOf("@");
  return at === -1 ? { contract: entry } : { contract: entry.slice(0, at), version: entry.slice(at + 1) };
}

/** A path as the map writes it, without `./` and trailing slashes (`.` is the repository root). */
export function cleanPath(path: string): string {
  const clean = path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return clean === "" ? "." : clean;
}

/** `path` inside the directory `dir` (`.` is the repository root). */
export function inDir(dir: string, path: string): string {
  const d = cleanPath(dir);
  return d === "." ? cleanPath(path) : `${d}/${cleanPath(path)}`;
}

/** The directory of an application inside its own repository (`.` for the whole repository). */
export const appDir = (app: Application): string => cleanPath(app.source.path ?? ".");

/** A contract's specification file, relative to its provider's repository; none when it is served. */
export const specPath = (owner: Application, contract: Contract): string | undefined =>
  "path" in contract.spec ? inDir(appDir(owner), contract.spec.path) : undefined;

/** Where a contract's specification is: its file, or the path its provider serves it at. */
export const specWhere = (owner: Application, contract: Contract): string =>
  specPath(owner, contract) ?? `served at ${(contract.spec as { served: string }).served}`;

/** The applications that consume a contract, with the version range each expects. */
export function consumersOf(
  map: SystemMap,
  contract: string,
): { readonly app: string; readonly range?: string }[] {
  return map.applications.flatMap((a) =>
    a.consumes
      .map(parseConsumes)
      .filter((p) => p.contract === contract)
      .map((p) => ({ app: a.id, ...(p.version ? { range: p.version } : {}) })),
  );
}

export interface SystemProblem {
  readonly severity: "error" | "warning";
  readonly path: string;
  readonly message: string;
}

/** References inside the map: owners, consumed contracts, contract kinds, duplicates. */
export function lintSystemMap(map: SystemMap, kinds: readonly string[]): SystemProblem[] {
  const problems: SystemProblem[] = [];
  const error = (path: string, message: string) => problems.push({ severity: "error", path, message });
  const apps = new Set<string>();
  map.applications.forEach((a, i) => {
    if (apps.has(a.id)) error(`applications.${i}.id`, `duplicate application "${a.id}"`);
    apps.add(a.id);
  });
  const contracts = new Map<string, Contract>();
  map.contracts.forEach((c, i) => {
    if (contracts.has(c.id)) error(`contracts.${i}.id`, `duplicate contract "${c.id}"`);
    contracts.set(c.id, c);
    if (!apps.has(c.owner))
      error(`contracts.${i}.owner`, `contract "${c.id}": owner "${c.owner}" is not an application`);
    if (!kinds.includes(c.kind))
      error(
        `contracts.${i}.kind`,
        `contract "${c.id}": kind "${c.kind}" has no plugin (supported: ${kinds.join(", ") || "none"})`,
      );
  });
  for (const [i, a] of map.applications.entries())
    for (const [j, entry] of a.consumes.entries()) {
      const { contract } = parseConsumes(entry);
      const c = contracts.get(contract);
      if (!c) error(`applications.${i}.consumes.${j}`, `"${a.id}" consumes unknown contract "${contract}"`);
      else if (c.owner === a.id)
        problems.push({
          severity: "warning",
          path: `applications.${i}.consumes.${j}`,
          message: `"${a.id}" consumes its own contract "${contract}"`,
        });
    }
  if (map.policies.deployOrder === "providers-first")
    for (const cycle of deployCycles(map))
      error("policies.deployOrder", `deploy cycle: ${cycle.join(" → ")} (providers-first cannot order it)`);
  return problems;
}

/** Edges provider → consumer for every consumed contract of a known provider. */
function deployGraph(map: SystemMap): Graph {
  const g = new Graph({ directed: true });
  for (const a of map.applications) g.setNode(a.id);
  const owner = new Map(map.contracts.map((c) => [c.id, c.owner]));
  for (const a of map.applications)
    for (const entry of a.consumes) {
      const provider = owner.get(parseConsumes(entry).contract);
      if (provider && provider !== a.id && g.hasNode(provider)) g.setEdge(provider, a.id);
    }
  return g;
}

function deployCycles(map: SystemMap): string[][] {
  return alg.findCycles(deployGraph(map)).map((c) => [...c].sort());
}

/**
 * Deploy waves under providers-first: every application deploys after the providers of the
 * contracts it consumes; applications in one wave are independent. Undefined with a cycle.
 */
export function deployWaves(map: SystemMap): string[][] | undefined {
  const g = deployGraph(map);
  if (alg.findCycles(g).length > 0) return undefined;
  const waves: string[][] = [];
  const done = new Set<string>();
  while (done.size < g.nodeCount()) {
    const wave = g
      .nodes()
      .filter((n) => !done.has(n) && (g.predecessors(n) ?? []).every((p) => done.has(p)))
      .sort();
    for (const n of wave) done.add(n);
    waves.push(wave);
  }
  return waves;
}

/** Who provides and who consumes each contract. */
export function contractUsers(map: SystemMap): {
  readonly contract: string;
  readonly kind: string;
  readonly owner: string;
  readonly consumers: readonly string[];
}[] {
  return map.contracts.map((c) => ({
    contract: c.id,
    kind: c.kind,
    owner: c.owner,
    consumers: consumersOf(map, c.id)
      .map((k) => k.app)
      .sort(),
  }));
}
