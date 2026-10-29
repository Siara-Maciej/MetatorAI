import type { Application, SystemMap } from "./system-map.ts";
import { parseConsumes } from "./system-map.ts";

/**
 * `system discover` (F7.2, ADR-0067): a proposed system map from what the code shows, every
 * application, contract and consumer with the evidence and how sure the evidence is. The map
 * stays a declaration a person approves; discovery proposes it and says where it drifted.
 */
export type Topology = "single" | "monorepo" | "repos";
export type Confidence = "high" | "medium" | "low";

export interface AppCandidate {
  readonly id: string;
  /** Where its code is, as the map writes it. */
  readonly source: Application["source"];
  readonly kind: Application["kind"];
  readonly owners: readonly string[];
  /** A Dockerfile makes it a deploy unit of its own. */
  readonly deployUnit?: string;
  /** Why this is an application. */
  readonly signals: readonly string[];
}

export interface FoundContract {
  /** The application whose source holds the specification. */
  readonly app: string;
  readonly kind: string;
  /** The specification, relative to the application's source. */
  readonly spec: string;
  readonly title: string;
  readonly version?: string;
  readonly servers: readonly string[];
}

export interface FoundReference {
  /** The consuming application. */
  readonly from: string;
  readonly contract: string;
  readonly file: string;
  readonly reason: string;
  readonly confidence: Confidence;
}

export interface DiscoveryEvidence {
  readonly subject: string;
  readonly reason: string;
  readonly file?: string;
  readonly confidence: Confidence;
  /** Low-confidence findings are shown, not proposed. */
  readonly proposed: boolean;
}

export interface SystemDiscovery {
  readonly topology: Topology;
  readonly proposal: SystemMap;
  readonly evidence: readonly DiscoveryEvidence[];
}

/** A map id from any name: `@shop/web` → `web`, `Billing API` → `billing-api`. */
export function slugId(name: string): string {
  const base = name.replace(/^@[^/]+\//, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id = /^[a-z]/.test(slug) ? slug : `x-${slug}`;
  return id === "x-" ? "app" : id;
}

const FRONTEND = ["react", "vue", "svelte", "@angular/core", "next", "nuxt", "vite", "solid-js", "preact"];
const SERVICE = ["express", "fastify", "hono", "koa", "@nestjs/core", "elysia", "@hapi/hapi"];

/** What kind of application its name and dependencies suggest. */
export function kindFrom(
  name: string,
  dependencies: readonly string[],
  hasSpec: boolean,
  bin = false,
): Application["kind"] {
  if (/(^|[-/])(worker|jobs?|cron|consumer)s?($|[-/])/.test(name)) return "worker";
  if (/(^|[-/])gateway($|[-/])/.test(name)) return "gateway";
  if (hasSpec || dependencies.some((d) => SERVICE.includes(d))) return "service";
  // A command-line tool is not a frontend, even when it draws with React (Ink).
  if (bin) return "other";
  if (dependencies.some((d) => FRONTEND.includes(d))) return "frontend";
  return "other";
}

/** Contract ids from titles, unique: `Billing API` twice becomes `billing-api` and `billing-api-2`. */
export function contractIds(found: readonly FoundContract[]): Map<FoundContract, string> {
  const ids = new Map<FoundContract, string>();
  const taken = new Set<string>();
  for (const c of found) {
    const base = slugId(c.title === c.spec ? c.spec.replace(/\.(ya?ml|json)$/, "") : c.title);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    ids.set(c, id);
  }
  return ids;
}

/** Needles that point at a specification from another application's files. */
export function needlesOf(
  contract: FoundContract,
  providerDir: string,
): { text: string; reason: string; confidence: Confidence }[] {
  const out: { text: string; reason: string; confidence: Confidence }[] = [];
  const last = providerDir.replace(/\/+$/, "").split("/").pop() ?? "";
  if (last && last !== ".")
    out.push({
      text: `${last}/${contract.spec}`,
      reason: `refers to the specification ${contract.spec}`,
      confidence: "medium",
    });
  for (const url of contract.servers) {
    const host = /^[a-z]+:\/\/([^/]+)/i.exec(url)?.[1];
    // A bare word (`billing`) matches too much; a dotted host or one with a port is specific.
    if (host && (host.includes(".") || host.includes(":")) && !/^(localhost|127\.0\.0\.1)(:|$)/.test(host))
      out.push({
        text: host,
        reason: `calls ${host}, where the specification says it is served`,
        confidence: "low",
      });
  }
  return out;
}

/** The proposed map with the evidence for every part of it. */
export function proposeSystem(input: {
  readonly system: string;
  readonly topology: Topology;
  readonly apps: readonly AppCandidate[];
  readonly contracts: readonly FoundContract[];
  readonly references: readonly FoundReference[];
  readonly ids: ReadonlyMap<FoundContract, string>;
}): SystemDiscovery {
  const evidence: DiscoveryEvidence[] = [];
  for (const a of input.apps)
    for (const s of a.signals)
      evidence.push({ subject: `application:${a.id}`, reason: s, confidence: "high", proposed: true });
  for (const c of input.contracts)
    evidence.push({
      subject: `contract:${input.ids.get(c)}`,
      reason: `${c.kind} specification "${c.title}"${c.version ? ` ${c.version}` : ""}`,
      file: c.spec,
      confidence: "high",
      proposed: true,
    });
  const consumes = new Map<string, Set<string>>();
  for (const r of input.references) {
    const proposed = r.confidence !== "low";
    evidence.push({
      subject: `consumes:${r.from}→${r.contract}`,
      reason: r.reason,
      file: r.file,
      confidence: r.confidence,
      proposed,
    });
    if (!proposed) continue;
    const set = consumes.get(r.from) ?? new Set<string>();
    set.add(r.contract);
    consumes.set(r.from, set);
  }
  const proposal: SystemMap = {
    system: input.system,
    applications: input.apps.map((a) => ({
      id: a.id,
      kind: a.kind,
      source: a.source,
      owners: [...a.owners],
      ...(a.deployUnit ? { deploy: { unit: a.deployUnit, environments: [] } } : {}),
      consumes: [...(consumes.get(a.id) ?? [])].sort(),
    })),
    contracts: input.contracts.map((c) => ({
      id: input.ids.get(c) as string,
      kind: c.kind,
      owner: c.app,
      spec: { path: c.spec },
      compatibility: "backward" as const,
    })),
    policies: { deployOrder: "providers-first", breaking: "expand-contract" },
  };
  return { topology: input.topology, proposal, evidence };
}

/** What the map lacks that the code shows (applications, contracts, consumers), as messages. */
export function systemDrift(map: SystemMap, proposal: SystemMap): string[] {
  const drift: string[] = [];
  const apps = new Map(map.applications.map((a) => [a.id, a]));
  for (const a of proposal.applications) {
    const known = apps.get(a.id);
    if (!known) {
      drift.push(`application ${a.id} is not in the map`);
      continue;
    }
    const consumed = new Set(known.consumes.map((c) => parseConsumes(c).contract));
    for (const c of a.consumes)
      if (!consumed.has(c)) drift.push(`${a.id} consumes ${c}, but the map does not say so`);
  }
  const contracts = new Map(map.contracts.map((c) => [c.id, c]));
  for (const c of proposal.contracts) {
    const known =
      contracts.get(c.id) ?? map.contracts.find((x) => x.owner === c.owner && x.spec.path === c.spec.path);
    if (!known) drift.push(`contract ${c.id} (${c.spec.path} of ${c.owner}) is not in the map`);
  }
  return drift;
}
