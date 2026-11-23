import type { JavaEvidence, JavaPersistenceUnit } from "./java-build.ts";
import { evidenceOf } from "./java-endpoints.ts";
import {
  allTypes,
  annotationNamed,
  type JavaAnnotation,
  type JavaTypeDecl,
  rawType,
  simpleAnnotationName,
  typeArguments,
} from "./java-model.ts";
import type { JavaFileRecord, JavaRepository } from "./java-repository.ts";

export interface JavaEntityColumn {
  readonly field: string;
  readonly type: string;
  readonly column?: string;
  readonly nullable?: boolean;
  readonly length?: number;
  readonly unique?: boolean;
  readonly enumerated?: "STRING" | "ORDINAL";
  readonly transient?: true;
  readonly embedded?: true;
  readonly at: string;
}

export type JavaRelationKind = "one-to-many" | "many-to-one" | "one-to-one" | "many-to-many";

export interface JavaEntityRelation {
  readonly field: string;
  readonly kind: JavaRelationKind;
  readonly target: string;
  readonly mappedBy?: string;
  readonly joinColumn?: string;
  readonly at: string;
}

export interface JavaEntity {
  readonly type: string;
  readonly kind: "entity" | "embeddable" | "mapped-superclass";
  readonly name?: string;
  readonly table?: string;
  readonly module: string;
  readonly at: string;
  readonly extends?: string;
  readonly inheritance?: string;
  readonly id: readonly { readonly field: string; readonly type: string; readonly generated?: string }[];
  readonly columns: readonly JavaEntityColumn[];
  readonly relations: readonly JavaEntityRelation[];
  readonly evidence: readonly JavaEvidence[];
}

export interface JavaPersistenceUnitFact extends Omit<JavaPersistenceUnit, "line"> {
  readonly at: string;
}

export interface JavaDataRepository {
  readonly type: string;
  readonly base: string;
  readonly entity?: string;
  readonly id?: string;
  readonly module: string;
  readonly at: string;
  readonly methods: readonly {
    readonly name: string;
    readonly kind: "derived" | "query" | "other";
    readonly query?: string;
    readonly native?: boolean;
    readonly at: string;
  }[];
  readonly evidence: readonly JavaEvidence[];
}

const RELATIONS: Readonly<Record<string, JavaRelationKind>> = {
  OneToMany: "one-to-many",
  ManyToOne: "many-to-one",
  OneToOne: "one-to-one",
  ManyToMany: "many-to-many",
};

const ENTITY_KINDS: Readonly<Record<string, JavaEntity["kind"]>> = {
  Entity: "entity",
  Embeddable: "embeddable",
  MappedSuperclass: "mapped-superclass",
};

/** The last word of an enum constant as written: `GenerationType.IDENTITY` → `IDENTITY`. */
const constant = (text: string | undefined) => text?.split(".").pop();

/** A persistent attribute: a field, or a getter when the mapping is on properties. */
interface Attribute {
  readonly name: string;
  readonly type: string;
  readonly annotations: readonly JavaAnnotation[];
  readonly modifiers: readonly string[];
  readonly line: number;
}

function attributes(t: JavaTypeDecl): Attribute[] {
  const fields: Attribute[] = t.fields.filter((f) => !f.modifiers.includes("static"));
  const jpa = (as: readonly JavaAnnotation[]) =>
    as.some((a) =>
      /^(Id|EmbeddedId|Column|OneToMany|ManyToOne|OneToOne|ManyToMany|Transient|Embedded)$/.test(
        simpleAnnotationName(a.name),
      ),
    );
  if (fields.some((f) => jpa(f.annotations))) return fields;
  const getters = t.methods
    .filter((m) => m.parameters.length === 0 && /^(get|is)[A-Z]/.test(m.name) && jpa(m.annotations))
    .map((m) => ({
      name: m.name.replace(/^(get|is)/, "").replace(/^./, (c) => c.toLowerCase()),
      type: m.returnType,
      annotations: m.annotations,
      modifiers: m.modifiers,
      line: m.line,
    }));
  return getters.length > 0 ? getters : fields;
}

/** The entity a relation points to: `targetEntity`, a collection's element, a map's value, the field's type. */
function relationTarget(
  repo: JavaRepository,
  file: JavaFileRecord,
  context: string,
  a: JavaAnnotation,
  type: string,
): string {
  const explicit = a.arguments.targetEntity?.text.replace(/\.class$/, "");
  if (explicit) return repo.resolve(explicit, file, context);
  const args = typeArguments(type);
  const element = args.length > 0 ? (args.at(-1) as string) : type;
  return repo.resolve(rawType(element), file, context);
}

/** JPA entities, embeddables and mapped superclasses (javax and jakarta). */
export function javaEntities(repo: JavaRepository): JavaEntity[] {
  const out: JavaEntity[] = [];
  for (const file of repo.files)
    for (const t of allTypes(file.facts.types)) {
      const marker = annotationNamed(t.annotations, "Entity", "Embeddable", "MappedSuperclass");
      if (!marker) continue;
      const context = t.qualifiedName;
      const table = annotationNamed(t.annotations, "Table");
      const inheritance = annotationNamed(t.annotations, "Inheritance");
      const id: JavaEntity["id"][number][] = [];
      const columns: JavaEntityColumn[] = [];
      const relations: JavaEntityRelation[] = [];
      for (const f of attributes(t)) {
        const at = `${file.path}:${f.line}`;
        const type = repo.resolveExpression(f.type, file, context);
        const relation = f.annotations.find((a) => simpleAnnotationName(a.name) in RELATIONS);
        if (relation) {
          const mappedBy = relation.arguments.mappedBy?.value;
          const join = annotationNamed(f.annotations, "JoinColumn")?.arguments.name?.value;
          relations.push({
            field: f.name,
            kind: RELATIONS[simpleAnnotationName(relation.name)] as JavaRelationKind,
            target: relationTarget(repo, file, context, relation, f.type),
            ...(typeof mappedBy === "string" ? { mappedBy } : {}),
            ...(typeof join === "string" ? { joinColumn: join } : {}),
            at,
          });
          continue;
        }
        if (annotationNamed(f.annotations, "Id", "EmbeddedId")) {
          const gen = annotationNamed(f.annotations, "GeneratedValue");
          id.push({
            field: f.name,
            type,
            ...(gen ? { generated: constant(gen.arguments.strategy?.text) ?? "AUTO" } : {}),
          });
        }
        const column = annotationNamed(f.annotations, "Column");
        const name = column?.arguments.name?.value;
        const nullable = column?.arguments.nullable?.value;
        const length = column?.arguments.length?.value;
        const unique = column?.arguments.unique?.value;
        const enumerated = annotationNamed(f.annotations, "Enumerated");
        const embeddedType = repo.entry(type);
        const embedded =
          !!annotationNamed(f.annotations, "Embedded") ||
          !!(embeddedType && annotationNamed(embeddedType.decl.annotations, "Embeddable"));
        columns.push({
          field: f.name,
          type,
          ...(typeof name === "string" ? { column: name } : {}),
          ...(typeof nullable === "boolean" ? { nullable } : {}),
          ...(typeof length === "number" ? { length } : {}),
          ...(typeof unique === "boolean" ? { unique } : {}),
          ...(enumerated
            ? {
                enumerated:
                  constant(enumerated.arguments.value?.text) === "STRING"
                    ? ("STRING" as const)
                    : ("ORDINAL" as const),
              }
            : {}),
          ...(annotationNamed(f.annotations, "Transient") || f.modifiers.includes("transient")
            ? { transient: true as const }
            : {}),
          ...(embedded ? { embedded: true as const } : {}),
          at,
        });
      }
      const superclass =
        t.kind === "class" && t.extends[0] ? repo.resolve(t.extends[0], file, context) : undefined;
      const entityName = marker.arguments.name?.value;
      const tableName = table?.arguments.name?.value;
      out.push({
        type: t.qualifiedName,
        kind: ENTITY_KINDS[simpleAnnotationName(marker.name)] as JavaEntity["kind"],
        ...(typeof entityName === "string" ? { name: entityName } : {}),
        ...(typeof tableName === "string" ? { table: tableName } : {}),
        module: file.module,
        at: `${file.path}:${t.line}`,
        ...(superclass && repo.entry(superclass) ? { extends: superclass } : {}),
        ...(inheritance
          ? { inheritance: constant(inheritance.arguments.strategy?.text) ?? "SINGLE_TABLE" }
          : {}),
        id,
        columns,
        relations,
        evidence: [marker, ...(table ? [table] : []), ...(inheritance ? [inheritance] : [])].map((a) =>
          evidenceOf(file, a),
        ),
      });
    }
  return out;
}

export function persistenceUnits(repo: JavaRepository): JavaPersistenceUnitFact[] {
  return repo.descriptors.flatMap((d) =>
    d.facts.persistenceUnits.map(({ line, ...u }) => ({ ...u, at: `${d.path}:${line}` })),
  );
}

const DATA_BASES = new Set([
  "Repository",
  "CrudRepository",
  "ListCrudRepository",
  "PagingAndSortingRepository",
  "ListPagingAndSortingRepository",
  "JpaRepository",
  "ReactiveCrudRepository",
  "ReactiveSortingRepository",
  "R2dbcRepository",
  "MongoRepository",
  "ReactiveMongoRepository",
  "ElasticsearchRepository",
  "CassandraRepository",
  "Neo4jRepository",
  "RevisionRepository",
]);

const DERIVED =
  /^(find|read|get|query|search|stream|count|exists|delete|remove)(First|Top|Distinct|All|\d)*[A-Z]?\w*By([A-Z]|$)|^(findAll|count|existsById|deleteAll)$/;

/** Spring Data repositories: interfaces extending a Spring Data base (directly or through a repository interface). */
export function javaRepositories(repo: JavaRepository): JavaDataRepository[] {
  const out: JavaDataRepository[] = [];
  /** The Spring Data base an interface reaches, with the type arguments given there. */
  const baseOf = (
    name: string,
    seen: Set<string>,
  ): { base: string; args: string[]; written: string } | undefined => {
    const e = repo.entry(name);
    if (!e || seen.has(name)) return undefined;
    seen.add(name);
    for (const s of e.decl.extends) {
      const raw = rawType(s).split(".").pop() as string;
      if (DATA_BASES.has(raw) && !repo.entry(repo.resolve(s, e.file, name)))
        return { base: raw, args: typeArguments(s), written: s };
      const inner = baseOf(repo.resolve(s, e.file, name), seen);
      if (inner) {
        // `interface Base<T> extends JpaRepository<T, Long>` and `X extends Base<Order>`: T is Order.
        const params =
          repo.entry(repo.resolve(s, e.file, name))?.decl.typeParameters.map((p) => p.split(" ")[0]) ?? [];
        const given = typeArguments(s);
        return {
          ...inner,
          args: inner.args.map((a) => (params.includes(a) ? (given[params.indexOf(a)] ?? a) : a)),
        };
      }
    }
    return undefined;
  };
  for (const file of repo.files)
    for (const t of allTypes(file.facts.types)) {
      if (t.kind !== "interface" || annotationNamed(t.annotations, "NoRepositoryBean")) continue;
      const definition = annotationNamed(t.annotations, "RepositoryDefinition");
      const found = definition
        ? {
            base: "RepositoryDefinition",
            args: [
              definition.arguments.domainClass?.text ?? "",
              definition.arguments.idClass?.text ?? "",
            ].map((x) => x.replace(/\.class$/, "")),
            written: "@RepositoryDefinition",
          }
        : baseOf(t.qualifiedName, new Set());
      if (!found) continue;
      const [entity, id] = found.args;
      out.push({
        type: t.qualifiedName,
        base: found.base,
        ...(entity ? { entity: repo.resolve(entity, file, t.qualifiedName) } : {}),
        ...(id ? { id: repo.resolve(id, file, t.qualifiedName) } : {}),
        module: file.module,
        at: `${file.path}:${t.line}`,
        methods: t.methods.map((m) => {
          const q = annotationNamed(m.annotations, "Query");
          const query = q?.arguments.value?.value;
          const native = q?.arguments.nativeQuery?.value;
          return {
            name: m.name,
            kind: q ? ("query" as const) : DERIVED.test(m.name) ? ("derived" as const) : ("other" as const),
            ...(typeof query === "string" ? { query } : {}),
            ...(native === true ? { native: true } : {}),
            at: `${file.path}:${m.line}`,
          };
        }),
        evidence: [
          {
            at: `${file.path}:${t.line}`,
            source: definition ? "@RepositoryDefinition" : `extends ${found.written}`,
          },
        ],
      });
    }
  return out;
}
