import type { JavaEvidence } from "./java-build.ts";
import { evidenceOf, type JavaConfidence } from "./java-endpoints.ts";
import {
  allTypes,
  annotationNamed,
  type JavaAnnotation,
  type JavaParameter,
  type JavaTypeDecl,
  rawType,
  simpleAnnotationName,
  typeArguments,
} from "./java-model.ts";
import { javaRepositories } from "./java-persistence.ts";
import type { JavaFileRecord, JavaRepository } from "./java-repository.ts";

export interface JavaInjection {
  readonly via: "field" | "constructor" | "setter" | "xml-property" | "xml-constructor" | "method-parameter";
  readonly name: string;
  readonly type: string;
  readonly annotation?: string;
  readonly qualifier?: string;
  readonly at: string;
  /** The bean that provides it when exactly one does (by qualifier or reference first, then by type). */
  readonly provider?: string;
  readonly candidates: number;
  readonly confidence: JavaConfidence;
}

export interface JavaBean {
  readonly name: string;
  readonly type: string;
  readonly kind: "spring" | "spring-bean-method" | "spring-xml" | "cdi" | "ejb";
  readonly stereotype: string;
  readonly scope?: string;
  readonly module: string;
  readonly at: string;
  readonly provides: readonly string[];
  readonly injections: readonly JavaInjection[];
  readonly evidence: readonly JavaEvidence[];
}

const SPRING = [
  "Component",
  "Service",
  "Repository",
  "Controller",
  "RestController",
  "Configuration",
  "ControllerAdvice",
  "RestControllerAdvice",
];
const CDI_SCOPES = ["ApplicationScoped", "RequestScoped", "SessionScoped", "ConversationScoped", "Dependent"];
const EJB = ["Stateless", "Stateful", "MessageDriven"];
const INJECT = ["Autowired", "Inject", "Resource", "EJB", "PersistenceContext", "PersistenceUnit"];
/** Wrappers an injection point unwraps: what is asked for is their argument. */
const PROVIDERS = new Set(["Optional", "ObjectProvider", "Provider", "Instance", "Lazy", "ObjectFactory"]);

const decapitalize = (s: string) => (/^[A-Z][A-Z]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** `@Singleton` of EJB (javax/jakarta.ejb) or of JSR-330 (javax/jakarta.inject): the file's import decides. */
function singletonKind(file: JavaFileRecord, a: JavaAnnotation): "ejb" | "cdi" {
  const imported = file.facts.imports.find(
    (i) => i.name.endsWith(".Singleton") || (i.onDemand && /\.(ejb|inject)$/.test(i.name)),
  );
  const name = a.name.includes(".") ? a.name : (imported?.name ?? "");
  return /\.inject(\.|$)/.test(name) ? "cdi" : "ejb";
}

interface Draft {
  bean: Omit<JavaBean, "injections">;
  points: (Omit<JavaInjection, "provider" | "candidates" | "confidence"> & { readonly ref?: string })[];
}

function qualifierOf(annotations: readonly JavaAnnotation[]): string | undefined {
  const q = annotationNamed(annotations, "Qualifier", "Named");
  const v = q?.arguments.value?.value;
  if (typeof v === "string") return v;
  const resource = annotationNamed(annotations, "Resource")?.arguments.name?.value;
  return typeof resource === "string" ? resource : undefined;
}

/** The type an injection point asks for: `Optional<X>`, `Provider<X>`, `List<X>` → X. */
function asked(
  repo: JavaRepository,
  file: JavaFileRecord,
  context: string,
  written: string,
): { type: string; many: boolean } {
  let t = written;
  let many = false;
  for (let i = 0; i < 3; i++) {
    const raw = rawType(t).split(".").pop() as string;
    if (PROVIDERS.has(raw)) t = typeArguments(t)[0] ?? t;
    else if (raw === "List" || raw === "Set" || raw === "Collection") {
      t = typeArguments(t)[0] ?? t;
      many = true;
    } else if (raw === "Map") {
      t = typeArguments(t)[1] ?? t;
      many = true;
    } else break;
  }
  return { type: repo.resolve(rawType(t), file, context), many };
}

function points(
  repo: JavaRepository,
  file: JavaFileRecord,
  t: JavaTypeDecl,
  spring: boolean,
): Draft["points"] {
  const out: Draft["points"] = [];
  const add = (
    via: JavaInjection["via"],
    name: string,
    written: string,
    annotations: readonly JavaAnnotation[],
    line: number,
  ) => {
    if (annotationNamed(annotations, "Value")) return; // configuration, not a bean
    const annotation = annotations.find((a) => INJECT.includes(simpleAnnotationName(a.name)));
    const qualifier = qualifierOf(annotations);
    out.push({
      via,
      name,
      type: asked(repo, file, t.qualifiedName, written).type,
      ...(annotation ? { annotation: simpleAnnotationName(annotation.name) } : {}),
      ...(qualifier ? { qualifier } : {}),
      at: `${file.path}:${line}`,
    });
  };
  for (const f of t.fields)
    if (f.annotations.some((a) => INJECT.includes(simpleAnnotationName(a.name))))
      add("field", f.name, f.type, f.annotations, f.line);
  const injecting = t.constructors.filter((c) => annotationNamed(c.annotations, "Autowired", "Inject"));
  // Spring injects through the only constructor without being asked (4.3+).
  const ctors =
    injecting.length > 0 ? injecting : spring && t.constructors.length === 1 ? t.constructors : [];
  for (const c of ctors)
    for (const p of c.parameters) add("constructor", p.name, p.type, p.annotations, c.line);
  // Lombok writes the constructor: final fields (@RequiredArgsConstructor) or all fields (@AllArgsConstructor).
  if (spring && t.constructors.length === 0) {
    const lombok = annotationNamed(t.annotations, "RequiredArgsConstructor", "AllArgsConstructor");
    if (lombok)
      for (const f of t.fields)
        if (
          !f.modifiers.includes("static") &&
          (simpleAnnotationName(lombok.name) === "AllArgsConstructor" || f.modifiers.includes("final"))
        )
          add("constructor", f.name, f.type, f.annotations, lombok.line);
  }
  for (const m of t.methods) {
    if (
      !m.annotations.some((a) =>
        ["Autowired", "Inject", "Resource", "EJB"].includes(simpleAnnotationName(a.name)),
      )
    )
      continue;
    for (const p of m.parameters as readonly JavaParameter[])
      add(
        m.name.startsWith("set") ? "setter" : "method-parameter",
        m.name.startsWith("set") && m.parameters.length === 1 ? decapitalize(m.name.slice(3)) : p.name,
        p.type,
        [...m.annotations, ...p.annotations],
        m.line,
      );
  }
  return out;
}

/** Every type a class can be injected as within reach: itself, its supertypes (qualified through the imports). */
function provided(repo: JavaRepository, name: string): string[] {
  return [name, ...repo.supertypes(name)];
}

/** Spring, CDI, EJB and Spring XML beans, each injection point resolved to its provider when exactly one fits. */
export function javaBeans(repo: JavaRepository): JavaBean[] {
  const drafts: Draft[] = [];
  for (const file of repo.files) {
    if (file.test) continue;
    for (const t of allTypes(file.facts.types)) {
      if (t.kind === "annotation") continue;
      const spring = annotationNamed(t.annotations, ...SPRING);
      const ejb = annotationNamed(t.annotations, ...EJB);
      const singleton = annotationNamed(t.annotations, "Singleton");
      const cdi = annotationNamed(t.annotations, ...CDI_SCOPES) ?? annotationNamed(t.annotations, "Named");
      const marker = spring ?? ejb ?? singleton ?? cdi;
      if (marker && t.kind !== "interface") {
        const kind: JavaBean["kind"] = spring
          ? "spring"
          : ejb
            ? "ejb"
            : singleton
              ? singletonKind(file, singleton)
              : "cdi";
        const explicit =
          (spring ?? annotationNamed(t.annotations, "Named"))?.arguments.value?.value ??
          (ejb ?? singleton)?.arguments.name?.value;
        const scope = annotationNamed(t.annotations, "Scope")?.arguments.value?.value;
        const cdiScope = annotationNamed(t.annotations, ...CDI_SCOPES);
        drafts.push({
          bean: {
            name:
              typeof explicit === "string" && explicit !== ""
                ? explicit
                : kind === "ejb"
                  ? t.name
                  : decapitalize(t.name),
            type: t.qualifiedName,
            kind,
            stereotype: simpleAnnotationName(marker.name),
            ...(typeof scope === "string"
              ? { scope }
              : cdiScope
                ? { scope: simpleAnnotationName(cdiScope.name) }
                : {}),
            module: file.module,
            at: `${file.path}:${t.line}`,
            provides: provided(repo, t.qualifiedName),
            evidence: [evidenceOf(file, marker)],
          },
          points: points(repo, file, t, kind === "spring"),
        });
      }
      // @Bean methods, in a @Configuration class or not ("lite" mode).
      for (const m of t.methods) {
        const a = annotationNamed(m.annotations, "Bean", "Produces");
        if (!a || (simpleAnnotationName(a.name) === "Produces" && !cdi && !ejb && !singleton)) continue;
        if (
          simpleAnnotationName(a.name) === "Produces" &&
          m.annotations.some((x) => simpleAnnotationName(x.name) === "Path")
        )
          continue;
        const names = a.arguments.name ?? a.arguments.value;
        const first = names?.items?.[0]?.value ?? names?.value;
        const type = repo.resolve(rawType(m.returnType), file, t.qualifiedName);
        drafts.push({
          bean: {
            name: typeof first === "string" ? first : m.name,
            type,
            kind: simpleAnnotationName(a.name) === "Bean" ? "spring-bean-method" : "cdi",
            stereotype: simpleAnnotationName(a.name),
            module: file.module,
            at: `${file.path}:${m.line}`,
            provides: provided(repo, type),
            evidence: [evidenceOf(file, a)],
          },
          points: m.parameters
            .filter((p) => !annotationNamed(p.annotations, "Value"))
            .map((p) => {
              const qualifier = qualifierOf(p.annotations);
              return {
                via: "method-parameter" as const,
                name: p.name,
                type: asked(repo, file, t.qualifiedName, p.type).type,
                ...(qualifier ? { qualifier } : {}),
                at: `${file.path}:${m.line}`,
              };
            }),
        });
      }
    }
  }
  // Spring Data repositories are beans: the interface is what gets injected.
  for (const r of javaRepositories(repo)) {
    const simple = r.type.slice(r.type.lastIndexOf(".") + 1);
    drafts.push({
      bean: {
        name: decapitalize(simple),
        type: r.type,
        kind: "spring",
        stereotype: "SpringDataRepository",
        module: r.module,
        at: r.at,
        provides: provided(repo, r.type),
        evidence: r.evidence,
      },
      points: [],
    });
  }
  for (const d of repo.descriptors)
    for (const b of d.facts.beans) {
      const simple = b.className.slice(b.className.lastIndexOf(".") + 1);
      const entry = repo.entry(b.className);
      const setterType = (property: string) => {
        const setter = entry?.decl.methods.find(
          (m) =>
            m.name === `set${property.charAt(0).toUpperCase()}${property.slice(1)}` &&
            m.parameters.length === 1,
        );
        const written =
          setter?.parameters[0]?.type ?? entry?.decl.fields.find((f) => f.name === property)?.type;
        return written && entry ? repo.resolve(written, entry.file, b.className) : (written ?? "?");
      };
      drafts.push({
        bean: {
          name: b.id ?? decapitalize(simple),
          type: b.className,
          kind: "spring-xml",
          stereotype: "bean",
          ...(b.scope ? { scope: b.scope } : {}),
          module: d.module,
          at: `${d.path}:${b.line}`,
          provides: entry ? provided(repo, b.className) : [b.className],
          evidence: [
            {
              at: `${d.path}:${b.line}`,
              source: `<bean${b.id ? ` id="${b.id}"` : ""} class="${b.className}">`,
            },
          ],
        },
        points: [
          ...b.properties
            .filter((p) => p.ref)
            .map((p) => ({
              via: "xml-property" as const,
              name: p.name,
              type: setterType(p.name),
              qualifier: p.ref as string,
              ref: p.ref as string,
              at: `${d.path}:${p.line}`,
            })),
          ...b.constructorArgs
            .filter((a) => a.ref)
            .map((a, i) => ({
              via: "xml-constructor" as const,
              name: `arg${i}`,
              type: "?",
              qualifier: a.ref as string,
              ref: a.ref as string,
              at: `${d.path}:${a.line}`,
            })),
        ],
      });
    }
  const beans = drafts.map((d) => d.bean);
  const primary = new Set(
    repo.files.flatMap((f) =>
      allTypes(f.facts.types)
        .filter((t) => annotationNamed(t.annotations, "Primary"))
        .map((t) => t.qualifiedName),
    ),
  );
  return drafts.map((d) => ({
    ...d.bean,
    injections: d.points.map(({ ref, ...p }) => {
      const byName = p.qualifier ? beans.filter((b) => b.name === p.qualifier) : [];
      const byType = beans.filter((b) => b.provides.includes(p.type) && b !== d.bean);
      if (byName.length === 1)
        return {
          ...p,
          provider: (byName[0] as Omit<JavaBean, "injections">).name,
          candidates: byType.length || 1,
          confidence: "certain" as const,
        };
      if (ref) return { ...p, candidates: 0, confidence: "likely" as const };
      if (byType.length === 1)
        return {
          ...p,
          provider: (byType[0] as Omit<JavaBean, "injections">).name,
          candidates: 1,
          confidence: "certain" as const,
        };
      const primaries = byType.filter((b) => primary.has(b.type));
      if (primaries.length === 1)
        return {
          ...p,
          provider: (primaries[0] as Omit<JavaBean, "injections">).name,
          candidates: byType.length,
          confidence: "likely" as const,
        };
      return { ...p, candidates: byType.length, confidence: "likely" as const };
    }),
  }));
}
