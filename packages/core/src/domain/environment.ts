import { alg, Graph } from "@dagrejs/graphlib";
import { z } from "zod";
import { fnv1a } from "./ids.ts";
import { defineDocument } from "./versioned.ts";
import type { PortBlock } from "./worktree.ts";

/**
 * How to start the application (F8.5, ADR-0053): services from Docker Compose or scripts, what
 * each needs, its ports and how to tell it is ready. Shared services (databases, brokers) run
 * once for every worktree; worktree services run per worktree on the worktree's ports.
 */
const Id = z.string().regex(/^[a-z][a-z0-9-]*$/, "use lowercase letters, digits and dashes");

const SourceSchema = z.union([
  z.strictObject({ compose: z.strictObject({ file: z.string().min(1), service: z.string().min(1) }) }),
  z.strictObject({ script: z.string().min(1), cwd: z.string().optional() }),
]);

const HealthSchema = z.union([
  /** A port name of the service (or a port number) that accepts TCP connections. */
  z.strictObject({ tcp: z.union([Id, z.number().int().positive()]) }),
  /** A path on the service's first port, or a full URL, that answers HTTP. */
  z.strictObject({ http: z.string().min(1) }),
]);

const ServiceV1Schema = z.strictObject({
  source: SourceSchema,
  scope: z.enum(["shared", "worktree", "on-demand"]).default("worktree"),
  needs: z.array(Id).default([]),
  /** Port name → the port outside a worktree; inside one, worktree services get ports of its block. */
  ports: z.record(Id, z.number().int().min(1).max(65535)).default({}),
  env: z.record(z.string().min(1), z.string()).default({}),
  health: HealthSchema.optional(),
  /** How long the service may take to become ready. */
  readyTimeoutMs: z.number().int().positive().default(120_000),
});

/** A command run in the service's directory with its environment, timed as one phase. */
const StepSchema = z.strictObject({ name: Id, run: z.string().min(1), cwd: z.string().optional() });

/** A Postgres database name MetatorAI creates and drops; no quoting is ever needed. */
export const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const DbName = z.string().regex(DB_NAME, "use lowercase letters, digits and underscores (at most 63)");

const IsolateSchema = z.union([
  /**
   * One database per place, cloned from a seeded template (`CREATE DATABASE … TEMPLATE`): the
   * service's `init` steps fill the template once; the checkout uses `database`.
   */
  z.strictObject({
    postgres: z.strictObject({
      template: DbName,
      database: DbName,
      user: z.string().min(1).default("postgres"),
      /** The port name to connect to (default: the service's first port). */
      port: Id.optional(),
    }),
  }),
  /** A prefix per place for keys, topics or queues: `{prefix:<service>}`. */
  z.strictObject({ prefix: z.literal(true) }),
]);

const WarmSchema = z.strictObject({
  /** Directories copied from the main checkout (copy-on-write where the disk can) before `prepare`. */
  reuse: z.array(z.string().min(1)).min(1),
  /** Files that must be equal in both checkouts for the copy to be valid (default: the lockfiles). */
  key: z.array(z.string().min(1)).optional(),
});

/** v2 (F8.7, ADR-0055): what code a service is, steps before and after it starts, data isolation, reuse. */
export const ServiceSchema = ServiceV1Schema.extend({
  /** Repository directories that are this service's code (`env up --affected`); none means all of it. */
  paths: z.array(z.string().min(1)).default([]),
  /** Before it starts, in order: install, build. */
  prepare: z.array(StepSchema).default([]),
  /** After it is ready, in order: migrations, seed. Shared services run them once. */
  init: z.array(StepSchema).default([]),
  isolate: IsolateSchema.optional(),
  warm: WarmSchema.optional(),
});
export type Service = z.output<typeof ServiceSchema>;
export type Step = z.output<typeof StepSchema>;

const environmentSchema = <S extends z.ZodType>(service: S) =>
  z.strictObject({
    services: z.record(Id, service).refine((s) => Object.keys(s).length > 0, "declare at least one service"),
    profiles: z.record(Id, z.array(Id).min(1)).default({}),
  });

export const EnvironmentSchema = environmentSchema(ServiceSchema);
export type Environment = z.output<typeof EnvironmentSchema>;

export const EnvironmentDocument = defineDocument("Environment", {
  history: [{ schema: environmentSchema(ServiceV1Schema) }],
  latest: EnvironmentSchema,
  // Every v1 service is a v2 service without paths, steps, isolation or reuse.
  upgrade: (v1) => v1,
  errorCode: "INVALID_CONFIG",
  hint: "`metator env discover` proposes one from your compose files and scripts; `metator env schema` prints the format.",
});

/** What runs now, per place: `.metator/env/<worktree id | main | shared>.json`. */
export const EnvStateSchema = z.strictObject({
  services: z.record(
    Id,
    z.strictObject({
      kind: z.enum(["process", "compose"]),
      pid: z.number().int().positive().optional(),
      project: z.string().optional(),
      ports: z.record(Id, z.number().int()),
      log: z.string().optional(),
      startedAt: z.iso.datetime(),
    }),
  ),
});
export type EnvState = z.output<typeof EnvStateSchema>;
export type RunningService = EnvState["services"][string];

export const EnvStateDocument = defineDocument("EnvState", {
  latest: EnvStateSchema,
  hint: "Written by `metator env up|down`; do not edit it by hand.",
});

export interface EnvironmentProblem {
  readonly service?: string;
  readonly message: string;
}

/** Needs and profiles point at declared services, needs have no cycle, health names a port. */
export function lintEnvironment(env: Environment): readonly EnvironmentProblem[] {
  const problems: EnvironmentProblem[] = [];
  const ids = new Set(Object.keys(env.services));
  for (const [id, s] of Object.entries(env.services)) {
    for (const n of s.needs)
      if (!ids.has(n)) problems.push({ service: id, message: `needs unknown service ${n}` });
    if (s.health && "tcp" in s.health && typeof s.health.tcp === "string" && !(s.health.tcp in s.ports))
      problems.push({
        service: id,
        message: `health checks port ${s.health.tcp}, which it does not declare`,
      });
    if (
      s.health &&
      "http" in s.health &&
      !s.health.http.startsWith("http") &&
      Object.keys(s.ports).length === 0
    )
      problems.push({ service: id, message: "an HTTP health path needs a port" });
    if (s.scope === "shared" && s.needs.some((n) => env.services[n]?.scope !== "shared"))
      problems.push({ service: id, message: "a shared service can need only shared services" });
    if (s.isolate && s.scope !== "shared")
      problems.push({ service: id, message: "only a shared service isolates data per worktree" });
    if (s.isolate && "postgres" in s.isolate) {
      const port = s.isolate.postgres.port;
      if (port ? !(port in s.ports) : Object.keys(s.ports).length === 0)
        problems.push({ service: id, message: "Postgres isolation needs a declared port to connect to" });
      if (s.isolate.postgres.template === s.isolate.postgres.database)
        problems.push({ service: id, message: "the template and the checkout's database must differ" });
    }
    if (s.warm && s.scope === "shared")
      problems.push({ service: id, message: "a shared service runs once; it has nothing to reuse" });
    const steps = [...s.prepare, ...s.init].map((x) => x.name);
    const twice = steps.filter((n, i) => steps.indexOf(n) !== i);
    if (twice.length > 0)
      problems.push({ service: id, message: `step names repeat: ${[...new Set(twice)].join(", ")}` });
  }
  for (const [p, list] of Object.entries(env.profiles))
    for (const s of list)
      if (!ids.has(s)) problems.push({ message: `profile ${p} names unknown service ${s}` });
  for (const cycle of alg.findCycles(needsGraph(env)))
    problems.push({ message: `services need each other in a cycle: ${cycle.sort().join(", ")}` });
  return problems;
}

function needsGraph(env: Environment): Graph {
  const g = new Graph();
  for (const id of Object.keys(env.services)) g.setNode(id);
  for (const [id, s] of Object.entries(env.services))
    for (const n of s.needs) if (env.services[n]) g.setEdge(n, id);
  return g;
}

/**
 * The services to start, in order: the wanted ones (default: every service that is not
 * on-demand) and everything they need, each after what it needs.
 */
export function startOrder(env: Environment, wanted?: readonly string[]): string[] {
  const roots = wanted ?? Object.keys(env.services).filter((id) => env.services[id]?.scope !== "on-demand");
  const take = new Set<string>();
  const visit = (id: string) => {
    if (take.has(id) || !env.services[id]) return;
    take.add(id);
    for (const n of env.services[id]?.needs ?? []) visit(n);
  };
  for (const r of roots) visit(r);
  const declared = Object.keys(env.services);
  return alg
    .topsort(needsGraph(env))
    .filter((id) => take.has(id))
    .sort((a, b) => depth(a) - depth(b) || declared.indexOf(a) - declared.indexOf(b));

  function depth(id: string): number {
    const needs = env.services[id]?.needs ?? [];
    return needs.length === 0 ? 0 : 1 + Math.max(...needs.map(depth));
  }
}

export type PortMap = Readonly<Record<string, Readonly<Record<string, number>>>>;

/**
 * Ports per service. In a worktree, worktree services take ports of its block in declaration
 * order; shared services keep theirs (one instance for every worktree). Undefined when the block
 * is too small.
 */
export function assignPorts(env: Environment, block?: PortBlock): PortMap | undefined {
  const out: Record<string, Record<string, number>> = {};
  let next = block?.from ?? 0;
  for (const [id, s] of Object.entries(env.services)) {
    const ports: Record<string, number> = {};
    for (const [name, port] of Object.entries(s.ports)) {
      if (block && s.scope !== "shared") {
        if (next >= block.from + block.count) return undefined;
        ports[name] = next++;
      } else ports[name] = port;
    }
    out[id] = ports;
  }
  return out;
}

const varName = (s: string) => s.toUpperCase().replaceAll("-", "_");

/** Where services run: a worktree id, "main" (this checkout) or "shared". */
export type Place = string;

/** The isolated data of a place: its own database or prefix; the checkout keeps `database` and no prefix. */
export function placeData(service: Service, place: Place): { database?: string; prefix?: string } {
  if (!service.isolate) return {};
  const tag = `wt_${place.replaceAll("-", "_")}`;
  if ("postgres" in service.isolate)
    return { database: place === "main" ? service.isolate.postgres.database : tag.slice(0, 63) };
  return { prefix: place === "main" ? "" : `${tag}_` };
}

export interface PostgresTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

/** How to reach a service's Postgres for isolation; undefined when it is not isolated that way. */
export function postgresTarget(env: Environment, ports: PortMap, id: string): PostgresTarget | undefined {
  const s = env.services[id];
  if (!s?.isolate || !("postgres" in s.isolate)) return undefined;
  const named = ports[id] ?? {};
  const port = s.isolate.postgres.port ? named[s.isolate.postgres.port] : Object.values(named)[0];
  return port === undefined ? undefined : { host: "127.0.0.1", port, user: s.isolate.postgres.user };
}

/**
 * The environment of one service in a place: every service's ports as
 * `METATOR_PORT_<SERVICE>_<NAME>`, its own first port as `PORT`, and its `env` with
 * `{port:<service>.<name>}`, `{db:<service>}` and `{prefix:<service>}` filled in.
 */
export function serviceEnv(
  env: Environment,
  ports: PortMap,
  id: string,
  place: Place = "main",
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [svc, named] of Object.entries(ports))
    for (const [name, port] of Object.entries(named))
      vars[`METATOR_PORT_${varName(svc)}_${varName(name)}`] = String(port);
  const own = Object.values(ports[id] ?? {});
  if (own.length > 0) vars.PORT = String(own[0]);
  const data = (svc: string) => {
    const s = env.services[svc];
    return s ? placeData(s, place) : {};
  };
  for (const [key, value] of Object.entries(env.services[id]?.env ?? {}))
    vars[key] = value
      .replace(/\{port:([a-z0-9-]+)\.([a-z0-9-]+)\}/g, (m, svc: string, name: string) =>
        String(ports[svc]?.[name] ?? m),
      )
      .replace(/\{db:([a-z0-9-]+)\}/g, (m, svc: string) => data(svc).database ?? m)
      .replace(/\{prefix:([a-z0-9-]+)\}/g, (m, svc: string) => data(svc).prefix ?? m);
  return vars;
}

/**
 * The services a change touches (`env up --affected`): those whose `paths` hold a changed file,
 * and those without `paths` (all of the repository is theirs) unless they are shared or on-demand.
 */
export function affectedServices(env: Environment, files: readonly string[]): string[] {
  if (files.length === 0) return [];
  const under = (file: string, dir: string) => {
    const d = dir.replace(/^\.\//, "").replace(/\/+$/, "");
    return d === "" || d === "." || file === d || file.startsWith(`${d}/`);
  };
  return Object.entries(env.services)
    .filter(([, s]) =>
      s.paths.length > 0 ? files.some((f) => s.paths.some((d) => under(f, d))) : s.scope === "worktree",
    )
    .map(([id]) => id);
}

/** The chain of needs that takes longest to start, by each service's measured time. */
export function criticalPath(env: Environment, ms: Readonly<Record<string, number>>): string[] {
  const best = new Map<string, { total: number; path: string[] }>();
  const visit = (id: string): { total: number; path: string[] } => {
    const known = best.get(id);
    if (known) return known;
    let longest = { total: 0, path: [] as string[] };
    for (const n of env.services[id]?.needs ?? []) {
      const sub = visit(n);
      if (sub.total > longest.total) longest = sub;
    }
    const mine = { total: longest.total + (ms[id] ?? 0), path: [...longest.path, id] };
    best.set(id, mine);
    return mine;
  };
  let top = { total: -1, path: [] as string[] };
  for (const id of Object.keys(env.services).filter((i) => i in ms)) {
    const c = visit(id);
    if (c.total > top.total) top = c;
  }
  return top.path.filter((id) => id in ms);
}

export type HealthTarget =
  | { readonly tcp: { readonly host: string; readonly port: number } }
  | { readonly http: string };

/** Where readiness is checked; undefined when the service declares no health check. */
export function healthTarget(env: Environment, ports: PortMap, id: string): HealthTarget | undefined {
  const s = env.services[id];
  if (!s?.health) return undefined;
  if ("tcp" in s.health) {
    const port = typeof s.health.tcp === "number" ? s.health.tcp : ports[id]?.[s.health.tcp];
    return port === undefined ? undefined : { tcp: { host: "127.0.0.1", port } };
  }
  if (s.health.http.startsWith("http")) return { http: s.health.http };
  const first = Object.values(ports[id] ?? {})[0];
  return first === undefined
    ? undefined
    : { http: `http://127.0.0.1:${first}${s.health.http.startsWith("/") ? "" : "/"}${s.health.http}` };
}

/** Images that are infrastructure: one instance is shared by every worktree (decision 3). */
export const SHARED_IMAGES =
  /(^|\/)(postgres|postgis|mysql|mariadb|redis|valkey|mongo|kafka|redpanda|rabbitmq|elasticsearch|opensearch|minio|zookeeper|memcached|localstack|mailhog|mailpit)([:@]|$)/;

/**
 * The Docker Compose project of a place: one per repository and place, so two repositories on one
 * machine never share containers (G1). Compose allows lowercase letters, digits, `-` and `_`.
 */
export function composeProject(root: string, place: Place): string {
  const base = (root.split(/[\\/]/).filter(Boolean).pop() ?? "repo").toLowerCase();
  const slug =
    base
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "repo";
  return `metator-${slug}-${fnv1a(root).slice(0, 6)}-${place}`;
}
