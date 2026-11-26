import type {
  JavaAnnotation,
  JavaBuild,
  JavaDescriptorFacts,
  JavaFileRecord,
  JavaMethod,
  JavaModule,
  JavaParameter,
  JavaParsedFile,
  JavaTypeDecl,
  JavaValue,
} from "../../src/index.ts";
import { JavaRepository, NO_DESCRIPTOR_FACTS } from "../../src/index.ts";

/** Builders of the Java model for tests: what the parser would have read. */

type Arg = string | number | boolean | JavaValue | readonly string[];

/** A string is a literal; `=X.Y` is an expression (a constant, an enum value). */
function val(a: Arg): JavaValue {
  if (Array.isArray(a))
    return { text: `{${a.join(", ")}}`, items: (a as readonly string[]).map((x) => val(x)) };
  if (typeof a === "string")
    return a.startsWith("=") ? { text: a.slice(1) } : { text: JSON.stringify(a), value: a };
  if (typeof a === "number" || typeof a === "boolean") return { text: String(a), value: a };
  return a as JavaValue;
}

export function ann(name: string, args: Readonly<Record<string, Arg>> | Arg = {}, line = 1): JavaAnnotation {
  const record =
    typeof args === "object" && !Array.isArray(args) && !("text" in (args as object))
      ? (args as Readonly<Record<string, Arg>>)
      : { value: args as Arg };
  return { name, arguments: Object.fromEntries(Object.entries(record).map(([k, a]) => [k, val(a)])), line };
}

export const param = (name: string, type: string, ...annotations: JavaAnnotation[]): JavaParameter => ({
  name,
  type,
  annotations,
});

export function method(name: string, o: Partial<JavaMethod> = {}): JavaMethod {
  return {
    name,
    returnType: "void",
    parameters: [],
    throws: [],
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    line: 1,
    ...o,
  };
}

export function type(qualifiedName: string, o: Partial<JavaTypeDecl> = {}): JavaTypeDecl {
  return {
    name: qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1),
    qualifiedName,
    kind: "class",
    line: 1,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fields: [],
    constructors: [],
    methods: [],
    enumConstants: [],
    components: [],
    nested: [],
    ...o,
  };
}

/** A file under `<module>/src/main/java/` (or `src/test/java` with `test`) holding the types. */
export function file(
  module: string,
  types: readonly JavaTypeDecl[],
  o: Partial<JavaParsedFile> & { readonly test?: boolean; readonly path?: string } = {},
): JavaFileRecord {
  const first = types[0]?.qualifiedName ?? "Unnamed";
  const pkg = o.package ?? first.slice(0, first.lastIndexOf("."));
  const { test, path, ...facts } = o;
  return {
    path: path ?? `${module}/src/${test ? "test" : "main"}/java/${first.replaceAll(".", "/")}.java`,
    facts: { package: pkg, imports: [], types: [...types], references: [], calls: [], ...facts },
    module,
    test: test === true,
    generated: false,
  };
}

export function module(name: string, o: Partial<JavaModule> = {}): JavaModule {
  return {
    name,
    dir: name,
    build: "maven",
    buildFile: `${name}/pom.xml`,
    sourceRoots: [],
    modules: [],
    dependencies: [],
    ...o,
  };
}

export function repo(
  files: readonly JavaFileRecord[],
  o: {
    readonly modules?: readonly JavaModule[];
    readonly descriptors?: readonly { path: string; facts: Partial<JavaDescriptorFacts>; module?: string }[];
  } = {},
): JavaRepository {
  const modules = o.modules ?? [...new Set(files.map((f) => f.module))].map((m) => module(m));
  const build: JavaBuild = { tools: ["maven"], modules, notes: [] };
  return new JavaRepository(
    build,
    files,
    (o.descriptors ?? []).map((d) => ({
      path: d.path,
      facts: { ...NO_DESCRIPTOR_FACTS, ...d.facts },
      module: d.module ?? "",
    })),
  );
}
