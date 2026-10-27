import { type Environment, type Service, SHARED_IMAGES } from "./environment.ts";

/** What `env discover` read, gathered by the use case (files parsed, nothing started). */
export interface EnvironmentFacts {
  /** Compose files: repo-relative path → parsed YAML. */
  readonly compose: readonly { readonly file: string; readonly doc: unknown }[];
  /** Start scripts of the root and every workspace package. */
  readonly scripts: readonly {
    readonly dir: string;
    readonly name: string;
    readonly script: string;
    readonly body: string;
  }[];
  /** How the repository runs its scripts (`bun run`, `npm run`, …). */
  readonly runScript: string;
  readonly procfile?: string;
  readonly makefile?: string;
}

export interface ServiceEvidence {
  readonly service: string;
  readonly from: string;
  readonly reason: string;
  readonly confidence: number;
}

export interface EnvironmentProposal {
  readonly environment: Environment | null;
  readonly evidence: readonly ServiceEvidence[];
  readonly warnings: readonly string[];
}

const id = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "") || "app";

function composePorts(ports: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of Array.isArray(ports) ? ports : []) {
    const text =
      typeof p === "object" && p !== null
        ? String((p as { published?: unknown }).published ?? "")
        : String(p);
    // "5432:5432", "127.0.0.1:8080:80", "3000" → the port on this machine
    const parts = text.split(":");
    const host = Number(parts.length >= 2 ? parts[parts.length - 2] : parts[0]);
    if (Number.isInteger(host) && host > 0) out[`p${host}`] = host;
  }
  return out;
}

function composeNeeds(dependsOn: unknown): string[] {
  if (Array.isArray(dependsOn)) return dependsOn.map(String);
  if (dependsOn && typeof dependsOn === "object") return Object.keys(dependsOn);
  return [];
}

/**
 * A proposed Environment from the facts, every service with the evidence it came from. Compose
 * services come first: an image of infrastructure is shared, anything built from the repository
 * runs per worktree. Start scripts, a Procfile and Makefile targets follow with lower confidence.
 */
export function proposeEnvironment(facts: EnvironmentFacts): EnvironmentProposal {
  const services: Record<string, Service> = {};
  const evidence: ServiceEvidence[] = [];
  const warnings: string[] = [];
  const add = (name: string, service: Service, e: Omit<ServiceEvidence, "service">) => {
    let key = id(name);
    for (let n = 2; services[key]; n++) key = `${id(name)}-${n}`;
    services[key] = service;
    evidence.push({ service: key, ...e });
    return key;
  };

  for (const { file, doc } of facts.compose) {
    const declared = (doc as { services?: Record<string, Record<string, unknown>> } | null)?.services ?? {};
    const renamed = new Map<string, string>();
    for (const [name, svc] of Object.entries(declared)) {
      const image = typeof svc.image === "string" ? svc.image : "";
      const shared = image !== "" && svc.build === undefined && SHARED_IMAGES.test(image);
      const ports = composePorts(svc.ports);
      const first = Object.keys(ports)[0];
      const key = add(
        name,
        {
          source: { compose: { file, service: name } },
          scope: shared ? "shared" : "worktree",
          needs: [],
          ports,
          env: {},
          ...(first ? { health: { tcp: first } } : {}),
          readyTimeoutMs: 120_000,
        },
        {
          from: `${file}#services.${name}`,
          reason: shared
            ? `infrastructure image ${image}: one instance for every worktree`
            : image
              ? `image ${image}`
              : "built from the repository",
          confidence: 0.9,
        },
      );
      renamed.set(name, key);
    }
    for (const [name, svc] of Object.entries(declared)) {
      const key = renamed.get(name) as string;
      const s = services[key] as Service;
      services[key] = {
        ...s,
        needs: composeNeeds(svc.depends_on).flatMap((n) =>
          renamed.has(n) ? [renamed.get(n) as string] : [],
        ),
      };
    }
  }

  for (const s of facts.scripts) {
    const port = /(?:--port[= ]|PORT=|-p )(\d{2,5})\b/.exec(s.body)?.[1];
    add(
      s.dir === "." ? (s.name === "dev" ? "app" : s.name) : (s.dir.split("/").pop() as string),
      {
        source: { script: `${facts.runScript} ${s.script}`, ...(s.dir === "." ? {} : { cwd: s.dir }) },
        scope: "worktree",
        needs: [],
        ports: port ? { http: Number(port) } : {},
        env: {},
        ...(port ? { health: { http: "/" } } : {}),
        readyTimeoutMs: 120_000,
      },
      {
        from: `${s.dir === "." ? "" : `${s.dir}/`}package.json#scripts.${s.script}`,
        reason: port
          ? `start script, port ${port} from its command`
          : "start script; no port found, add one for a health check",
        confidence: port ? 0.7 : 0.5,
      },
    );
  }

  for (const line of (facts.procfile ?? "").split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    add(
      m[1] as string,
      {
        source: { script: (m[2] as string).trim() },
        scope: "worktree",
        needs: [],
        ports: {},
        env: {},
        readyTimeoutMs: 120_000,
      },
      { from: `Procfile#${m[1]}`, reason: "Procfile process", confidence: 0.6 },
    );
  }

  if (Object.keys(services).length === 0) {
    for (const target of ["dev", "run", "start", "up"]) {
      if (!new RegExp(`^${target}:`, "m").test(facts.makefile ?? "")) continue;
      add(
        `make-${target}`,
        {
          source: { script: `make ${target}` },
          scope: "worktree",
          needs: [],
          ports: {},
          env: {},
          readyTimeoutMs: 120_000,
        },
        { from: `Makefile#${target}`, reason: "Makefile target; check what it starts", confidence: 0.4 },
      );
      break;
    }
  }

  if (Object.keys(services).length === 0) {
    warnings.push("nothing to start was found: no compose file, start script, Procfile or Makefile target");
    return { environment: null, evidence, warnings };
  }
  for (const [key, s] of Object.entries(services))
    if (!s.health) warnings.push(`${key}: no health check; env up cannot tell when it is ready`);
  return { environment: { services, profiles: {} }, evidence, warnings };
}
