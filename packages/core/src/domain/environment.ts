import { alg, Graph } from "@dagrejs/graphlib";
import { z } from "zod";
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

export const ServiceSchema = z.strictObject({
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
export type Service = z.output<typeof ServiceSchema>;

export const EnvironmentSchema = z.strictObject({
  services: z
    .record(Id, ServiceSchema)
    .refine((s) => Object.keys(s).length > 0, "declare at least one service"),
  profiles: z.record(Id, z.array(Id).min(1)).default({}),
});
export type Environment = z.output<typeof EnvironmentSchema>;

export const EnvironmentDocument = defineDocument("Environment", {
  latest: EnvironmentSchema,
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

/**
 * The environment of one service: every service's ports as `METATOR_PORT_<SERVICE>_<NAME>`, its
 * own first port as `PORT`, and its `env` with `{port:<service>.<name>}` filled in.
 */
export function serviceEnv(env: Environment, ports: PortMap, id: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [svc, named] of Object.entries(ports))
    for (const [name, port] of Object.entries(named))
      vars[`METATOR_PORT_${varName(svc)}_${varName(name)}`] = String(port);
  const own = Object.values(ports[id] ?? {});
  if (own.length > 0) vars.PORT = String(own[0]);
  for (const [key, value] of Object.entries(env.services[id]?.env ?? {}))
    vars[key] = value.replace(/\{port:([a-z0-9-]+)\.([a-z0-9-]+)\}/g, (m, svc: string, name: string) =>
      String(ports[svc]?.[name] ?? m),
    );
  return vars;
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
