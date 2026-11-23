import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * What one `.java` file declares, as the Java reader parsed it (ADR-0107): its package, imports,
 * types with their members and annotations, the type names it uses and the router calls worth a
 * framework rule. It is cached per file in the `JavaIndex` document (`.metator/index/java.json`)
 * by content fingerprint, so only changed files are parsed again.
 */

/** An annotation argument or a constant's initializer: its source text, and its value when it is a literal. */
export interface JavaValue {
  readonly text: string;
  /** A string literal (or a concatenation of them), a number or a boolean. */
  readonly value?: string | number | boolean | undefined;
  /** The items of an array initializer `{a, b}`. */
  readonly items?: readonly JavaValue[] | undefined;
}

export const JavaValueSchema: z.ZodType<JavaValue> = z.lazy(() =>
  z
    .object({
      text: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
      items: z.array(JavaValueSchema).optional(),
    })
    .strict(),
);

export const JavaAnnotationSchema = z
  .object({
    /** As written, without `@`: `GetMapping`, `jakarta.ws.rs.GET`. */
    name: z.string(),
    /** A single unnamed argument is `value`. */
    arguments: z.record(z.string(), JavaValueSchema),
    line: z.number().int(),
  })
  .strict();
export type JavaAnnotation = z.infer<typeof JavaAnnotationSchema>;

export const JavaParameterSchema = z
  .object({
    name: z.string(),
    /** The type as written, without whitespace: `List<OrderDto>`, `String[]`. */
    type: z.string(),
    annotations: z.array(JavaAnnotationSchema),
    varargs: z.literal(true).optional(),
  })
  .strict();
export type JavaParameter = z.infer<typeof JavaParameterSchema>;

export const JavaFieldSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    modifiers: z.array(z.string()),
    annotations: z.array(JavaAnnotationSchema),
    line: z.number().int(),
    /** The initializer, when it is a literal (constants that paths and keys are built from). */
    value: JavaValueSchema.optional(),
  })
  .strict();
export type JavaField = z.infer<typeof JavaFieldSchema>;

export const JavaMethodSchema = z
  .object({
    name: z.string(),
    /** `void` when it returns nothing. */
    returnType: z.string(),
    parameters: z.array(JavaParameterSchema),
    throws: z.array(z.string()),
    modifiers: z.array(z.string()),
    annotations: z.array(JavaAnnotationSchema),
    typeParameters: z.array(z.string()),
    line: z.number().int(),
  })
  .strict();
export type JavaMethod = z.infer<typeof JavaMethodSchema>;

export const JavaConstructorSchema = z
  .object({
    parameters: z.array(JavaParameterSchema),
    throws: z.array(z.string()),
    modifiers: z.array(z.string()),
    annotations: z.array(JavaAnnotationSchema),
    line: z.number().int(),
  })
  .strict();
export type JavaConstructor = z.infer<typeof JavaConstructorSchema>;

export const JAVA_TYPE_KINDS = ["class", "interface", "enum", "record", "annotation"] as const;
export type JavaTypeKind = (typeof JAVA_TYPE_KINDS)[number];

/** One declared type. */
export interface JavaTypeDecl {
  readonly name: string;
  /** `package.Outer.Inner`. */
  readonly qualifiedName: string;
  readonly kind: JavaTypeKind;
  readonly line: number;
  readonly modifiers: readonly string[];
  readonly annotations: readonly JavaAnnotation[];
  readonly typeParameters: readonly string[];
  /** A class extends at most one type; an interface any number. As written. */
  readonly extends: readonly string[];
  readonly implements: readonly string[];
  readonly permits: readonly string[];
  readonly fields: readonly JavaField[];
  readonly constructors: readonly JavaConstructor[];
  readonly methods: readonly JavaMethod[];
  readonly enumConstants: readonly string[];
  /** A record's components. */
  readonly components: readonly JavaParameter[];
  readonly nested: readonly JavaTypeDecl[];
}

export const JavaTypeDeclSchema: z.ZodType<JavaTypeDecl> = z.lazy(() =>
  z
    .object({
      name: z.string(),
      qualifiedName: z.string(),
      kind: z.enum(JAVA_TYPE_KINDS),
      line: z.number().int(),
      modifiers: z.array(z.string()),
      annotations: z.array(JavaAnnotationSchema),
      typeParameters: z.array(z.string()),
      extends: z.array(z.string()),
      implements: z.array(z.string()),
      permits: z.array(z.string()),
      fields: z.array(JavaFieldSchema),
      constructors: z.array(JavaConstructorSchema),
      methods: z.array(JavaMethodSchema),
      enumConstants: z.array(z.string()),
      components: z.array(JavaParameterSchema),
      nested: z.array(JavaTypeDeclSchema),
    })
    .strict(),
);

export const JavaImportSchema = z
  .object({
    /** `java.util.List`; the package for `java.util.*`; the member for a static import. */
    name: z.string(),
    static: z.boolean(),
    onDemand: z.boolean(),
    line: z.number().int(),
  })
  .strict();
export type JavaImport = z.infer<typeof JavaImportSchema>;

/** A method call a framework rule reads (RouterFunction DSL: `route()`, `GET(...)`, `nest(...)`). */
export const JavaCallSchema = z
  .object({
    name: z.string(),
    arguments: z.array(JavaValueSchema),
    line: z.number().int(),
    /** Index (in `calls`) of the call whose arguments hold this one, or whose receiver chain it ends. */
    within: z.number().int().optional(),
    /** The enclosing type and method: `com.example.Routes#routes`. */
    in: z.string(),
  })
  .strict();
export type JavaCall = z.infer<typeof JavaCallSchema>;

export const JavaParsedFileSchema = z
  .object({
    package: z.string(),
    imports: z.array(JavaImportSchema),
    types: z.array(JavaTypeDeclSchema),
    /** Simple type names the file uses (same-package and on-demand references). */
    references: z.array(z.string()),
    calls: z.array(JavaCallSchema),
    /** The file could not be fully parsed: what was read is kept, the file is reported. */
    error: z.object({ message: z.string(), line: z.number().int().optional() }).strict().optional(),
  })
  .strict();
export type JavaParsedFile = z.infer<typeof JavaParsedFileSchema>;

export const JavaIndexSchema = z
  .object({
    /** The parser and its extraction version: another one rebuilds every entry. */
    parser: z.string(),
    files: z.record(z.string(), z.object({ fingerprint: z.string(), facts: JavaParsedFileSchema }).strict()),
  })
  .strict();
export type JavaIndex = z.infer<typeof JavaIndexSchema>;

export const JavaIndexDocument = defineDocument("JavaIndex", { latest: JavaIndexSchema });

/** The simple name of a type as written: `Map.Entry<K, V>[]` → `Entry`, `java.util.List<X>` → `List`. */
export function simpleTypeName(type: string): string {
  const base = rawType(type);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : base;
}

/** A type without its type arguments and array dimensions: `List<Order>[]` → `List`. */
export function rawType(type: string): string {
  const lt = type.indexOf("<");
  return (lt >= 0 ? type.slice(0, lt) : type).replace(/(\[\])+$/, "").replace(/\.\.\.$/, "");
}

/** The type arguments of a type as written, split at the top level: `Map<K,List<V>>` → [`K`, `List<V>`]. */
export function typeArguments(type: string): string[] {
  const lt = type.indexOf("<");
  if (lt < 0) return [];
  const end = type.lastIndexOf(">");
  const inner = type.slice(lt + 1, end < 0 ? undefined : end);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "<") depth++;
    else if (c === ">") depth--;
    else if (c === "," && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = inner.slice(start).trim();
  if (last !== "") out.push(last);
  return out;
}

/** An annotation of a declaration by simple name (`Entity` matches `@Entity` and `@jakarta.persistence.Entity`). */
export function annotationNamed(
  annotations: readonly JavaAnnotation[],
  ...names: readonly string[]
): JavaAnnotation | undefined {
  return annotations.find((a) => names.includes(simpleAnnotationName(a.name)));
}

export function simpleAnnotationName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : name;
}

/** A string argument's value(s): `"a"` → [a], `{"a", "b"}` → [a, b]; undefined when absent or not literal. */
export function stringValues(value: JavaValue | undefined): string[] | undefined {
  if (!value) return undefined;
  if (value.items) {
    const out: string[] = [];
    for (const item of value.items) {
      if (typeof item.value !== "string") return undefined;
      out.push(item.value);
    }
    return out;
  }
  return typeof value.value === "string" ? [value.value] : undefined;
}

/** Every type of a file, nested ones included, outermost first. */
export function allTypes(types: readonly JavaTypeDecl[]): JavaTypeDecl[] {
  const out: JavaTypeDecl[] = [];
  const walk = (t: JavaTypeDecl) => {
    out.push(t);
    for (const n of t.nested) walk(n);
  };
  for (const t of types) walk(t);
  return out;
}
