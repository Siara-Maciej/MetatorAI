import type { JavaEvidence } from "./java-build.ts";
import { evidenceOf } from "./java-endpoints.ts";
import {
  allTypes,
  annotationNamed,
  type JavaAnnotation,
  rawType,
  simpleAnnotationName,
} from "./java-model.ts";
import type { JavaRepository } from "./java-repository.ts";

export interface JavaConfigKey {
  readonly key: string;
  readonly value: string;
  readonly profile?: string;
  readonly at: string;
}

export interface JavaConfigRead {
  readonly key: string;
  readonly via: "@Value" | "@ConfigurationProperties";
  readonly type: string;
  readonly member: string;
  readonly default?: string;
  readonly defined: boolean;
  readonly at: string;
}

export interface JavaEntrypoint {
  readonly kind:
    | "main"
    | "scheduled"
    | "kafka-listener"
    | "jms-listener"
    | "rabbit-listener"
    | "event-listener"
    | "message-driven"
    | "startup";
  readonly handler: string;
  readonly detail?: string;
  readonly module: string;
  readonly at: string;
  readonly evidence: readonly JavaEvidence[];
}

export interface JavaFramework {
  readonly name: string;
  readonly count: number;
  readonly evidence: readonly JavaEvidence[];
}

/** Spring's relaxed binding: `maxLines`, `max-lines`, `max_lines` and `MAX_LINES` are one key. */
export const canonicalKey = (key: string): string => key.toLowerCase().replace(/[-_]/g, "");

/** `maxLines` → `max-lines` (the canonical form Spring documents). */
export const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

export function configKeys(repo: JavaRepository): JavaConfigKey[] {
  return repo.descriptors.flatMap((d) =>
    d.facts.config.map((c) => ({
      key: c.key,
      value: c.value,
      ...(c.profile ? { profile: c.profile } : {}),
      at: `${d.path}:${c.line}`,
    })),
  );
}

/** `${a.b:default}` placeholders of a `@Value` string; SpEL (`#{...}`) is not a key. */
export function placeholders(text: string): { key: string; default?: string }[] {
  return [...text.matchAll(/\$\{([^}:]+)(?::([^}]*))?\}/g)].map((m) => ({
    key: (m[1] as string).trim(),
    ...(m[2] !== undefined ? { default: m[2] } : {}),
  }));
}

/** Where code reads configuration: `@Value("${key}")` and `@ConfigurationProperties(prefix)` classes. */
export function configReads(repo: JavaRepository): JavaConfigRead[] {
  const defined = new Set(configKeys(repo).map((k) => canonicalKey(k.key)));
  const isDefined = (key: string) =>
    defined.has(canonicalKey(key)) ||
    [...defined].some((d) => d.startsWith(`${canonicalKey(key)}.`) || d.startsWith(`${canonicalKey(key)}[`));
  const out: JavaConfigRead[] = [];
  for (const file of repo.files)
    for (const t of allTypes(file.facts.types)) {
      const values = (member: string, annotations: readonly JavaAnnotation[], line: number) => {
        const v = annotationNamed(annotations, "Value")?.arguments.value?.value;
        if (typeof v !== "string") return;
        for (const p of placeholders(v))
          out.push({
            key: p.key,
            via: "@Value",
            type: t.qualifiedName,
            member,
            ...(p.default !== undefined ? { default: p.default } : {}),
            defined: isDefined(p.key),
            at: `${file.path}:${line}`,
          });
      };
      for (const f of t.fields) values(f.name, f.annotations, f.line);
      for (const c of t.constructors) for (const p of c.parameters) values(p.name, p.annotations, c.line);
      for (const m of t.methods) for (const p of m.parameters) values(p.name, p.annotations, m.line);
      const bound = (prefix: string, typeName: string, line: number) => {
        const target = repo.entry(typeName);
        if (!target) return;
        const members = [
          ...target.decl.fields
            .filter((f) => !f.modifiers.includes("static"))
            .map((f) => ({ name: f.name, line: f.line })),
          ...target.decl.components.map((c) => ({ name: c.name, line: target.decl.line })),
        ];
        for (const m of members) {
          const key = `${prefix}.${kebab(m.name)}`;
          out.push({
            key,
            via: "@ConfigurationProperties",
            type: typeName,
            member: m.name,
            defined: isDefined(key),
            at: `${target.file.path}:${m.line || line}`,
          });
        }
      };
      const props = annotationNamed(t.annotations, "ConfigurationProperties");
      const prefixOf = (a: JavaAnnotation) => {
        const v = (a.arguments.prefix ?? a.arguments.value)?.value;
        return typeof v === "string" ? v : "";
      };
      if (props) bound(prefixOf(props), t.qualifiedName, props.line);
      for (const m of t.methods) {
        const a = annotationNamed(m.annotations, "ConfigurationProperties");
        if (a) bound(prefixOf(a), repo.resolve(rawType(m.returnType), file, t.qualifiedName), a.line);
      }
    }
  return out;
}

const LISTENERS: Readonly<Record<string, { kind: JavaEntrypoint["kind"]; keys: readonly string[] }>> = {
  Scheduled: {
    kind: "scheduled",
    keys: ["cron", "fixedRate", "fixedDelay", "fixedRateString", "fixedDelayString", "initialDelay"],
  },
  Schedule: { kind: "scheduled", keys: ["second", "minute", "hour", "dayOfWeek", "dayOfMonth", "month"] },
  KafkaListener: { kind: "kafka-listener", keys: ["topics", "topicPattern", "groupId", "id"] },
  JmsListener: { kind: "jms-listener", keys: ["destination", "subscription"] },
  RabbitListener: { kind: "rabbit-listener", keys: ["queues", "bindings"] },
  EventListener: { kind: "event-listener", keys: ["classes", "value", "condition"] },
  TransactionalEventListener: { kind: "event-listener", keys: ["classes", "value", "phase"] },
};

const detailOf = (a: JavaAnnotation, keys: readonly string[]) =>
  keys
    .filter((k) => a.arguments[k] !== undefined)
    .map((k) => `${k}=${a.arguments[k]?.value ?? a.arguments[k]?.text}`)
    .join(", ");

/** `main` methods, scheduled jobs, message and event listeners, message-driven and startup beans. */
export function javaEntrypoints(repo: JavaRepository): JavaEntrypoint[] {
  const out: JavaEntrypoint[] = [];
  for (const file of repo.files) {
    if (file.test) continue;
    for (const t of allTypes(file.facts.types)) {
      for (const m of t.methods) {
        const at = `${file.path}:${m.line}`;
        if (
          m.name === "main" &&
          m.modifiers.includes("static") &&
          m.returnType === "void" &&
          m.parameters.length === 1 &&
          /^String(\[\]|\.\.\.)$/.test(m.parameters[0]?.type ?? "")
        )
          out.push({
            kind: "main",
            handler: `${t.qualifiedName}#main`,
            module: file.module,
            at,
            evidence: [{ at, source: "static void main(String[])" }],
          });
        for (const a of m.annotations) {
          const l = LISTENERS[simpleAnnotationName(a.name)];
          if (!l) continue;
          let detail = detailOf(a, l.keys);
          if (!detail && l.kind === "event-listener" && m.parameters[0])
            detail = repo.resolve(m.parameters[0].type, file, t.qualifiedName);
          out.push({
            kind: l.kind,
            handler: `${t.qualifiedName}#${m.name}`,
            ...(detail ? { detail } : {}),
            module: file.module,
            at,
            evidence: [evidenceOf(file, a)],
          });
        }
      }
      const at = `${file.path}:${t.line}`;
      const mdb = annotationNamed(t.annotations, "MessageDriven");
      if (mdb) {
        const config = mdb.arguments.activationConfig;
        const items = config?.items ?? (config ? [config] : []);
        const destination = items
          .map(
            (i) =>
              /propertyName\s*=\s*"(destinationLookup|destination)"\s*,\s*propertyValue\s*=\s*"([^"]+)"/.exec(
                i.text,
              )?.[2],
          )
          .find((x) => x !== undefined);
        const mapped = mdb.arguments.mappedName?.value;
        const d = destination ?? (typeof mapped === "string" ? mapped : undefined);
        out.push({
          kind: "message-driven",
          handler: t.qualifiedName,
          ...(d ? { detail: d } : {}),
          module: file.module,
          at,
          evidence: [evidenceOf(file, mdb)],
        });
      }
      const startup = annotationNamed(t.annotations, "Startup");
      if (startup)
        out.push({
          kind: "startup",
          handler: t.qualifiedName,
          module: file.module,
          at,
          evidence: [evidenceOf(file, startup)],
        });
      const runner = t.implements.find((i) =>
        /^(CommandLineRunner|ApplicationRunner)$/.test(rawType(i).split(".").pop() ?? ""),
      );
      if (runner)
        out.push({
          kind: "startup",
          handler: `${t.qualifiedName}#run`,
          detail: runner,
          module: file.module,
          at,
          evidence: [{ at, source: `implements ${runner}` }],
        });
    }
  }
  return out;
}

interface FrameworkRule {
  readonly name: string;
  readonly artifacts: RegExp;
  readonly annotations: readonly string[];
}

const FRAMEWORKS: readonly FrameworkRule[] = [
  {
    name: "spring-boot",
    artifacts: /^spring-boot/,
    annotations: ["SpringBootApplication", "EnableAutoConfiguration", "ConfigurationProperties"],
  },
  {
    name: "spring-mvc",
    artifacts: /^spring-(webmvc|web|boot-starter-web)$/,
    annotations: [
      "RestController",
      "Controller",
      "RequestMapping",
      "GetMapping",
      "PostMapping",
      "PutMapping",
      "DeleteMapping",
      "PatchMapping",
    ],
  },
  { name: "spring-webflux", artifacts: /^spring-(webflux|boot-starter-webflux)$/, annotations: [] },
  {
    name: "spring-data",
    artifacts: /^spring-(data-[\w-]+|boot-starter-data-[\w-]+)$/,
    annotations: ["Query", "RepositoryDefinition", "EnableJpaRepositories"],
  },
  {
    name: "jpa",
    artifacts:
      /^(jakarta\.persistence-api|javax\.persistence(-api)?|hibernate-core|hibernate-entitymanager|persistence-api|spring-boot-starter-data-jpa)$/,
    annotations: ["Entity", "Embeddable", "MappedSuperclass", "PersistenceContext"],
  },
  {
    name: "jax-rs",
    artifacts: /^(jakarta\.ws\.rs-api|javax\.ws\.rs-api|jsr311-api|jersey-[\w-]+|resteasy-[\w-]+)$/,
    annotations: ["Path", "ApplicationPath"],
  },
  {
    name: "ejb",
    artifacts: /^(jakarta\.ejb-api|javax\.ejb(-api)?|ejb-api)$/,
    annotations: ["Stateless", "Stateful", "MessageDriven", "EJB"],
  },
  {
    name: "cdi",
    artifacts: /^(jakarta\.enterprise\.cdi-api|cdi-api|jakarta\.inject-api|javax\.inject)$/,
    annotations: ["ApplicationScoped", "RequestScoped", "SessionScoped", "Dependent", "Inject"],
  },
  {
    name: "servlet",
    artifacts: /^(jakarta\.servlet-api|javax\.servlet-api|servlet-api)$/,
    annotations: ["WebServlet", "WebFilter", "WebListener"],
  },
  {
    name: "spring",
    artifacts: /^spring-(context|core|beans)$/,
    annotations: ["Component", "Service", "Repository", "Configuration", "Bean", "Autowired"],
  },
  { name: "kafka", artifacts: /^(spring-kafka|kafka-clients)$/, annotations: ["KafkaListener"] },
  { name: "jms", artifacts: /^(spring-jms|jakarta\.jms-api|javax\.jms-api)$/, annotations: ["JmsListener"] },
  {
    name: "rabbitmq",
    artifacts: /^(spring-rabbit|spring-boot-starter-amqp|amqp-client)$/,
    annotations: ["RabbitListener"],
  },
];

/** Which frameworks the repository uses, from the build's dependencies, the annotations and the descriptors, with counts. */
export function javaFrameworks(repo: JavaRepository): JavaFramework[] {
  const usages = new Map<string, { at: string; source: string }[]>();
  for (const file of repo.files)
    for (const t of allTypes(file.facts.types)) {
      const all = [
        ...t.annotations,
        ...t.fields.flatMap((f) => f.annotations),
        ...t.methods.flatMap((m) => [...m.annotations, ...m.parameters.flatMap((p) => p.annotations)]),
        ...t.constructors.flatMap((c) => c.annotations),
      ];
      for (const a of all) {
        const n = simpleAnnotationName(a.name);
        usages.set(n, [...(usages.get(n) ?? []), evidenceOf(file, a)]);
      }
    }
  const out: JavaFramework[] = [];
  for (const rule of FRAMEWORKS) {
    const evidence: JavaEvidence[] = [];
    let count = 0;
    for (const m of repo.build.modules)
      for (const d of m.dependencies)
        if (!d.module && rule.artifacts.test(d.artifact)) {
          evidence.push({
            at: `${m.buildFile}:${d.line ?? 1}`,
            source: `dependency ${d.group}:${d.artifact}`,
          });
        }
    for (const a of rule.annotations) {
      const used = usages.get(a) ?? [];
      count += used.length;
      evidence.push(...used);
    }
    if (rule.name === "spring-webflux") {
      const routes = repo.files.flatMap((f) =>
        f.facts.calls
          .filter((c) => /^(GET|POST|PUT|DELETE|PATCH)$/.test(c.name))
          .map((c) => ({ at: `${f.path}:${c.line}`, source: `${c.name}(...)` })),
      );
      count += routes.length;
      evidence.push(...routes);
    }
    for (const d of repo.descriptors) {
      const add = (n: number, source: string, line: number) => {
        count += n;
        evidence.push({ at: `${d.path}:${line}`, source });
      };
      if (rule.name === "servlet") for (const s of d.facts.servlets) add(1, `<servlet> ${s.name}`, s.line);
      if (rule.name === "jpa")
        for (const u of d.facts.persistenceUnits) add(1, `<persistence-unit name="${u.name}">`, u.line);
      if (rule.name === "spring-xml")
        for (const b of d.facts.beans) add(1, `<bean class="${b.className}">`, b.line);
    }
    if (count === 0 && evidence.length === 0) continue;
    out.push({ name: rule.name, count, evidence: evidence.slice(0, 5) });
  }
  const xml = repo.descriptors.flatMap((d) =>
    d.facts.beans.map((b) => ({ at: `${d.path}:${b.line}`, source: `<bean class="${b.className}">` })),
  );
  if (xml.length > 0) out.push({ name: "spring-xml", count: xml.length, evidence: xml.slice(0, 5) });
  return out;
}
