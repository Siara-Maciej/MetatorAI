import type { JavaEvidence } from "./java-build.ts";
import {
  allTypes,
  annotationNamed,
  type JavaAnnotation,
  type JavaMethod,
  type JavaTypeDecl,
  type JavaValue,
  rawType,
  simpleAnnotationName,
  typeArguments,
} from "./java-model.ts";
import type { JavaFileRecord, JavaRepository } from "./java-repository.ts";

export type JavaConfidence = "certain" | "likely";
export type JavaWebFramework = "spring-mvc" | "webflux" | "jax-rs" | "servlet";

export interface JavaEndpointParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "body" | "cookie" | "form" | "matrix";
  readonly type: string;
  readonly required?: boolean;
}

export interface JavaEndpoint {
  readonly framework: JavaWebFramework;
  /** `GET`, `POST`, ...; `*` when any method. */
  readonly method: string;
  readonly path: string;
  /** `com.example.OrderController#get`; the class for a servlet. */
  readonly handler: string;
  readonly module: string;
  readonly at: string;
  readonly parameters: readonly JavaEndpointParameter[];
  readonly requestType?: string;
  readonly responseType?: string;
  readonly produces?: readonly string[];
  readonly consumes?: readonly string[];
  readonly confidence: JavaConfidence;
  readonly evidence: readonly JavaEvidence[];
}

/** `@GetMapping("/{id}")` as written (arguments abbreviated). */
export function annotationSource(a: JavaAnnotation): string {
  const entries = Object.entries(a.arguments);
  if (entries.length === 0) return `@${a.name}`;
  if (entries.length === 1 && entries[0]?.[0] === "value") return `@${a.name}(${entries[0][1].text})`;
  return `@${a.name}(${entries.map(([k, v]) => `${k} = ${v.text}`).join(", ")})`;
}

export const evidenceOf = (file: JavaFileRecord, a: JavaAnnotation): JavaEvidence => ({
  at: `${file.path}:${a.line}`,
  source: annotationSource(a),
});

/** `/api/` + `/{id}` → `/api/{id}`; nothing at all → `/`. */
export function joinPaths(...parts: readonly string[]): string {
  const joined = parts
    .map((p) => p.trim())
    .filter((p) => p !== "" && p !== "/")
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p !== "")
    .join("/");
  return `/${joined}`;
}

/**
 * The strings an annotation argument holds: literals, or constants of the repository
 * (`ApiPaths.CUSTOMERS`, `BASE`) read from their declaration, which makes the fact `likely`.
 */
export function stringsOf(
  repo: JavaRepository,
  value: JavaValue | undefined,
  file: JavaFileRecord,
  context: string,
): { values: string[]; likely: boolean } {
  if (!value) return { values: [], likely: false };
  const items = value.items ?? [value];
  const values: string[] = [];
  let likely = false;
  for (const item of items) {
    if (typeof item.value === "string") {
      values.push(item.value);
      continue;
    }
    likely = true;
    const constant = constantValue(repo, item.text, file, context);
    values.push(constant ?? `{${item.text}}`);
  }
  return { values, likely };
}

/** A `static final` String constant's value by name as written (`Paths.BASE`, `BASE`), when the repository declares it. */
export function constantValue(
  repo: JavaRepository,
  text: string,
  file: JavaFileRecord,
  context: string,
): string | undefined {
  // `A + B` of constants and literals.
  if (text.includes("+")) {
    const parts = text.split("+").map((p) => p.trim());
    const out: string[] = [];
    for (const p of parts) {
      const lit = /^"(.*)"$/.exec(p);
      const v = lit ? lit[1] : constantValue(repo, p, file, context);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out.join("");
  }
  const dot = text.lastIndexOf(".");
  const owner = dot >= 0 ? repo.resolve(text.slice(0, dot), file, context) : context;
  const name = dot >= 0 ? text.slice(dot + 1) : text;
  for (let o = owner; o !== ""; o = repo.entry(o)?.outer ?? "") {
    const field = repo.entry(o)?.decl.fields.find((f) => f.name === name);
    if (field && typeof field.value?.value === "string") return field.value.value;
    if (field) return undefined;
  }
  // A static import of the constant.
  const imp = file.facts.imports.find((i) => i.static && i.name.endsWith(`.${name}`));
  if (imp && dot < 0) {
    const entry = repo.entry(imp.name.slice(0, imp.name.lastIndexOf(".")));
    const field = entry?.decl.fields.find((f) => f.name === name);
    if (typeof field?.value?.value === "string") return field.value.value;
  }
  return undefined;
}

const SPRING_MAPPINGS: Readonly<Record<string, string | undefined>> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
  RequestMapping: undefined,
};

const WRAPPERS = new Set([
  "ResponseEntity",
  "HttpEntity",
  "Mono",
  "Optional",
  "CompletableFuture",
  "CompletionStage",
  "DeferredResult",
  "Callable",
  "Uni",
  "WebAsyncTask",
  "ListenableFuture",
]);

/** `ResponseEntity<T>`, `Mono<T>`, `Mono<ResponseEntity<T>>` → T; `Flux<T>`/`Multi<T>` → `T[]`; `void` → undefined. */
export function unwrapResponse(type: string): string | undefined {
  let t = type;
  let many = false;
  for (let i = 0; i < 5; i++) {
    const raw = rawType(t).split(".").pop() ?? "";
    if (raw === "Flux" || raw === "Multi" || raw === "Publisher") {
      many = true;
      t = typeArguments(t)[0] ?? "";
    } else if (WRAPPERS.has(raw)) t = typeArguments(t)[0] ?? "";
    else break;
  }
  if (
    t === "" ||
    t === "void" ||
    t === "Void" ||
    t === "?" ||
    /^(Response|ServerResponse|ResponseEntity)$/.test(t)
  )
    return undefined;
  return many ? `${t}[]` : t;
}

const isWebflux = (repo: JavaRepository, file: JavaFileRecord, m: JavaMethod) => {
  const raw = rawType(m.returnType).split(".").pop();
  if (raw === "Mono" || raw === "Flux") return true;
  const module = repo.module(file.module);
  return !!module?.dependencies.some((d) => /spring-(boot-starter-)?webflux/.test(d.artifact));
};

function springParameters(repo: JavaRepository, file: JavaFileRecord, t: JavaTypeDecl, m: JavaMethod) {
  const parameters: JavaEndpointParameter[] = [];
  let requestType: string | undefined;
  for (const p of m.parameters) {
    const type = repo.resolveExpression(p.type, file, t.qualifiedName);
    const kinds: readonly [string, JavaEndpointParameter["in"]][] = [
      ["PathVariable", "path"],
      ["RequestParam", "query"],
      ["RequestHeader", "header"],
      ["RequestBody", "body"],
      ["CookieValue", "cookie"],
      ["MatrixVariable", "matrix"],
      ["ModelAttribute", "form"],
      ["RequestPart", "form"],
    ];
    for (const [annotation, where] of kinds) {
      const a = annotationNamed(p.annotations, annotation);
      if (!a) continue;
      const named = a.arguments.value ?? a.arguments.name;
      const name = typeof named?.value === "string" && named.value !== "" ? named.value : p.name;
      const required = a.arguments.required?.value;
      const optional =
        required === false || a.arguments.defaultValue !== undefined || rawType(p.type) === "Optional";
      if (where === "body") requestType = type;
      parameters.push({ name, in: where, type, ...(where === "path" ? {} : { required: !optional }) });
      break;
    }
  }
  return { parameters, ...(requestType ? { requestType } : {}) };
}

/** Spring MVC and annotated WebFlux controllers. */
export function springEndpoints(repo: JavaRepository): JavaEndpoint[] {
  const out: JavaEndpoint[] = [];
  for (const file of repo.files)
    for (const t of allTypes(file.facts.types)) {
      const controller = annotationNamed(t.annotations, "RestController", "Controller");
      if (!controller) continue;
      const rest = simpleAnnotationName(controller.name) === "RestController";
      const base = annotationNamed(t.annotations, "RequestMapping");
      const classPaths = base
        ? stringsOf(repo, base.arguments.value ?? base.arguments.path, file, t.qualifiedName)
        : { values: [""], likely: false };
      for (const m of t.methods) {
        const mapping = m.annotations.find((a) => simpleAnnotationName(a.name) in SPRING_MAPPINGS);
        if (!mapping) continue;
        const kind = simpleAnnotationName(mapping.name);
        const methodPaths = stringsOf(
          repo,
          mapping.arguments.value ?? mapping.arguments.path,
          file,
          t.qualifiedName,
        );
        let verbs: string[] = [];
        if (SPRING_MAPPINGS[kind]) verbs = [SPRING_MAPPINGS[kind] as string];
        else {
          const methods = mapping.arguments.method;
          verbs = (methods?.items ?? (methods ? [methods] : [])).map(
            (v) => v.text.split(".").pop() as string,
          );
          if (verbs.length === 0) verbs = ["*"];
        }
        const { parameters, requestType } = springParameters(repo, file, t, m);
        const body =
          rest ||
          !!annotationNamed(m.annotations, "ResponseBody") ||
          !!annotationNamed(t.annotations, "ResponseBody");
        const response = unwrapResponse(m.returnType);
        const responseType =
          body && response ? repo.resolveExpression(response, file, t.qualifiedName) : undefined;
        const strings = (key: string) => {
          const v = stringsOf(
            repo,
            mapping.arguments[key] ?? base?.arguments[key],
            file,
            t.qualifiedName,
          ).values;
          return v.length > 0 ? v : undefined;
        };
        const produces = strings("produces");
        const consumes = strings("consumes");
        const evidence = [
          ...(base ? [evidenceOf(file, base)] : [evidenceOf(file, controller)]),
          evidenceOf(file, mapping),
        ];
        for (const cp of classPaths.values.length > 0 ? classPaths.values : [""])
          for (const mp of methodPaths.values.length > 0 ? methodPaths.values : [""])
            for (const verb of verbs)
              out.push({
                framework: isWebflux(repo, file, m) ? "webflux" : "spring-mvc",
                method: verb,
                path: joinPaths(cp, mp),
                handler: `${t.qualifiedName}#${m.name}`,
                module: file.module,
                at: `${file.path}:${m.line}`,
                parameters,
                ...(requestType ? { requestType } : {}),
                ...(responseType ? { responseType } : {}),
                ...(produces ? { produces } : {}),
                ...(consumes ? { consumes } : {}),
                confidence: classPaths.likely || methodPaths.likely ? "likely" : "certain",
                evidence,
              });
      }
    }
  return out;
}

const HTTP_VERBS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

/** WebFlux `RouterFunction` DSL routes, best effort: always `likely`. */
export function routerEndpoints(repo: JavaRepository): JavaEndpoint[] {
  const out: JavaEndpoint[] = [];
  for (const file of repo.files) {
    const calls = file.facts.calls;
    calls.forEach((call, i) => {
      if (!HTTP_VERBS.has(call.name)) return;
      const first = call.arguments[0];
      const path = typeof first?.value === "string" ? first.value : undefined;
      if (path === undefined) return;
      const prefixes: string[] = [];
      let handlerText = call.arguments[1]?.text;
      for (let w = call.within; w !== undefined; w = calls[w]?.within) {
        const outer = calls[w];
        if (!outer) break;
        if ((outer.name === "path" || outer.name === "nest") && outer !== calls[i]) {
          const p = outer.arguments[0];
          const value =
            typeof p?.value === "string"
              ? p.value
              : /^(?:\w+\.)?path\(\s*"([^"]*)"\s*\)$/.exec(p?.text ?? "")?.[1];
          if (value !== undefined && outer.line <= call.line) prefixes.unshift(value);
        }
        if ((outer.name === "route" || outer.name === "andRoute") && handlerText === undefined)
          handlerText = outer.arguments[1]?.text;
      }
      const [owner, methodName] = call.in.split("#");
      const handler = handlerOf(repo, file, handlerText, owner ?? "", methodName);
      out.push({
        framework: "webflux",
        method: call.name,
        path: joinPaths(...prefixes, path),
        handler: handler ?? call.in,
        module: file.module,
        at: `${file.path}:${call.line}`,
        parameters: [...path.matchAll(/\{(\w+)[^}]*\}/g)].map((m) => ({
          name: m[1] as string,
          in: "path" as const,
          type: "String",
        })),
        confidence: "likely",
        evidence: [
          {
            at: `${file.path}:${call.line}`,
            source: `${call.name}(${call.arguments.map((a) => a.text).join(", ")})`,
          },
        ],
      });
    });
  }
  return out;
}

/** `handler::list` → `com.example.ProductHandler#list`, through the parameter or field named `handler`. */
function handlerOf(
  repo: JavaRepository,
  file: JavaFileRecord,
  text: string | undefined,
  owner: string,
  method: string | undefined,
): string | undefined {
  const m = /^([\w.]+)::(\w+)$/.exec(text ?? "");
  if (!m) return undefined;
  const target = m[1] as string;
  const entry = repo.entry(owner);
  const declared =
    entry?.decl.methods.find((x) => x.name === method)?.parameters.find((p) => p.name === target)?.type ??
    entry?.decl.fields.find((f) => f.name === target)?.type;
  const type = declared ? repo.resolve(declared, file, owner) : repo.resolve(target, file, owner);
  return `${type}#${m[2]}`;
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  APPLICATION_JSON: "application/json",
  APPLICATION_XML: "application/xml",
  TEXT_PLAIN: "text/plain",
  TEXT_HTML: "text/html",
  TEXT_XML: "text/xml",
  APPLICATION_FORM_URLENCODED: "application/x-www-form-urlencoded",
  MULTIPART_FORM_DATA: "multipart/form-data",
  APPLICATION_OCTET_STREAM: "application/octet-stream",
  WILDCARD: "*/*",
};

function mediaTypes(value: JavaValue | undefined): string[] | undefined {
  if (!value) return undefined;
  return (value.items ?? [value]).map((v) =>
    typeof v.value === "string" ? v.value : (MEDIA_TYPES[v.text.split(".").pop() ?? ""] ?? v.text),
  );
}

const JAXRS_VERBS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

/** JAX-RS resources: `@ApplicationPath` + class `@Path` + method `@Path`. */
export function jaxrsEndpoints(repo: JavaRepository): JavaEndpoint[] {
  const applications = new Map<string, { path: string; evidence: JavaEvidence }>();
  for (const file of repo.files)
    for (const t of allTypes(file.facts.types)) {
      const a = annotationNamed(t.annotations, "ApplicationPath");
      const v = a?.arguments.value?.value;
      if (a && typeof v === "string")
        applications.set(file.module, { path: v, evidence: evidenceOf(file, a) });
    }
  const out: JavaEndpoint[] = [];
  for (const file of repo.files)
    for (const t of allTypes(file.facts.types)) {
      const classPath = annotationNamed(t.annotations, "Path");
      const resourceMethods = t.methods.filter((m) =>
        m.annotations.some((a) => JAXRS_VERBS.has(simpleAnnotationName(a.name))),
      );
      if (!classPath || resourceMethods.length === 0) continue;
      const app =
        applications.get(file.module) ??
        (applications.size === 1 ? [...applications.values()][0] : undefined);
      const base = stringsOf(repo, classPath.arguments.value, file, t.qualifiedName);
      for (const m of resourceMethods) {
        const verb = m.annotations.find((a) =>
          JAXRS_VERBS.has(simpleAnnotationName(a.name)),
        ) as JavaAnnotation;
        const own = annotationNamed(m.annotations, "Path");
        const sub = own
          ? stringsOf(repo, own.arguments.value, file, t.qualifiedName)
          : { values: [""], likely: false };
        const parameters: JavaEndpointParameter[] = [];
        let requestType: string | undefined;
        for (const p of m.parameters) {
          const type = repo.resolveExpression(p.type, file, t.qualifiedName);
          const kinds: readonly [string, JavaEndpointParameter["in"]][] = [
            ["PathParam", "path"],
            ["QueryParam", "query"],
            ["HeaderParam", "header"],
            ["CookieParam", "cookie"],
            ["FormParam", "form"],
            ["MatrixParam", "matrix"],
          ];
          const found = kinds.find(([k]) => annotationNamed(p.annotations, k));
          if (found) {
            const a = annotationNamed(p.annotations, found[0]) as JavaAnnotation;
            const name = typeof a.arguments.value?.value === "string" ? a.arguments.value.value : p.name;
            parameters.push({
              name,
              in: found[1],
              type,
              ...(found[1] === "path" ? {} : { required: false }),
            });
          } else if (!annotationNamed(p.annotations, "Context", "BeanParam", "Suspended")) {
            requestType = type;
            parameters.push({ name: p.name, in: "body", type, required: true });
          }
        }
        const response = unwrapResponse(m.returnType);
        const produces = mediaTypes(
          (annotationNamed(m.annotations, "Produces") ?? annotationNamed(t.annotations, "Produces"))
            ?.arguments.value,
        );
        const consumes = mediaTypes(
          (annotationNamed(m.annotations, "Consumes") ?? annotationNamed(t.annotations, "Consumes"))
            ?.arguments.value,
        );
        const evidence = [
          ...(app ? [app.evidence] : []),
          evidenceOf(file, classPath),
          evidenceOf(file, verb),
          ...(own ? [evidenceOf(file, own)] : []),
        ];
        for (const cp of base.values)
          for (const mp of sub.values)
            out.push({
              framework: "jax-rs",
              method: simpleAnnotationName(verb.name),
              path: joinPaths(app?.path ?? "", cp, mp),
              handler: `${t.qualifiedName}#${m.name}`,
              module: file.module,
              at: `${file.path}:${m.line}`,
              parameters,
              ...(requestType ? { requestType } : {}),
              ...(response ? { responseType: repo.resolveExpression(response, file, t.qualifiedName) } : {}),
              ...(produces ? { produces } : {}),
              ...(consumes ? { consumes } : {}),
              confidence: base.likely || sub.likely ? "likely" : "certain",
              evidence,
            });
      }
    }
  return out;
}

const SERVLET_METHODS: Readonly<Record<string, string>> = {
  doGet: "GET",
  doPost: "POST",
  doPut: "PUT",
  doDelete: "DELETE",
  doHead: "HEAD",
  doOptions: "OPTIONS",
  doPatch: "PATCH",
};

/** The HTTP methods a servlet class answers (its `doX` overrides); `*` when it overrides `service` or is not in the repository. */
function servletVerbs(t: JavaTypeDecl | undefined): string[] {
  if (!t || t.methods.some((m) => m.name === "service")) return ["*"];
  const verbs = t.methods.map((m) => SERVLET_METHODS[m.name]).filter((v): v is string => v !== undefined);
  return verbs.length > 0 ? verbs : ["*"];
}

/** `@WebServlet` classes and `web.xml` servlet mappings. */
export function servletEndpoints(repo: JavaRepository): JavaEndpoint[] {
  const out: JavaEndpoint[] = [];
  for (const file of repo.files)
    for (const t of allTypes(file.facts.types)) {
      const a = annotationNamed(t.annotations, "WebServlet");
      if (!a) continue;
      const patterns = stringsOf(repo, a.arguments.urlPatterns ?? a.arguments.value, file, t.qualifiedName);
      for (const pattern of patterns.values)
        for (const verb of servletVerbs(t))
          out.push({
            framework: "servlet",
            method: verb,
            path: pattern,
            handler: t.qualifiedName,
            module: file.module,
            at: `${file.path}:${t.line}`,
            parameters: [],
            confidence: patterns.likely ? "likely" : "certain",
            evidence: [evidenceOf(file, a)],
          });
    }
  for (const d of repo.descriptors)
    for (const s of d.facts.servlets) {
      const entry = repo.entry(s.className);
      for (const pattern of s.urlPatterns)
        for (const verb of servletVerbs(entry?.decl))
          out.push({
            framework: "servlet",
            method: verb,
            path: pattern,
            handler: s.className,
            module: d.module,
            at: `${d.path}:${s.line}`,
            parameters: [],
            confidence: "certain",
            evidence: [
              {
                at: `${d.path}:${s.line}`,
                source: `<servlet> ${s.name} → <url-pattern>${pattern}</url-pattern>`,
              },
            ],
          });
    }
  return out;
}

/** Every endpoint of the repository, in file order. */
export function javaEndpoints(repo: JavaRepository): JavaEndpoint[] {
  const all = [
    ...springEndpoints(repo),
    ...routerEndpoints(repo),
    ...jaxrsEndpoints(repo),
    ...servletEndpoints(repo),
  ];
  return all.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.at.localeCompare(b.at),
  );
}
