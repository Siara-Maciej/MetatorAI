import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { type ErrorCode, MetatorError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

/**
 * Every file MetatorAI reads or writes is a versioned document (ADR-0016): it starts with a
 * header `{ kind, schemaVersion }` that says how to parse it. Readers dispatch on the version,
 * migrate older documents step by step to the current one, and refuse newer ones.
 *
 * Version schemas describe the body only (the header is validated separately), so the same
 * strict zod schemas keep rejecting unknown keys.
 */
export interface DocumentVersion {
  readonly schema: z.ZodType;
  /** Converts a valid body of the previous version into this version's body. Not used for v1. */
  readonly fromPrevious?: (previous: unknown) => unknown;
}

export interface DocumentHeader {
  readonly kind: string;
  readonly schemaVersion: number;
}

export interface VersionedDocument<Body> {
  readonly kind: string;
  /** The version writers stamp and readers migrate to. */
  readonly current: number;
  /** Parses any supported version and returns the body migrated to the current version. */
  parse(raw: unknown, source: string): Result<Body, MetatorError>;
  /** Adds the current header to a body; the only way documents get written. */
  stamp(body: Body): DocumentHeader & Body;
  /** JSON Schema of the current version, header included (for agents and editors). */
  jsonSchema(io?: "input" | "output"): Record<string, unknown>;
}

const HeaderSchema = z.object({ kind: z.string(), schemaVersion: z.number().int() });

export interface DocumentDefinition<S extends z.ZodType> {
  /** Body schema of the current version. */
  readonly latest: S;
  /** Migration from the newest historical version to `latest` (required when history exists). */
  readonly upgrade?: (previous: unknown) => unknown;
  /** Older versions, oldest first: history[0] is v1. Each later entry migrates from the one before. */
  readonly history?: readonly DocumentVersion[];
  /** Error code for invalid documents: INVALID_CONFIG for user-authored specs, else INVALID_ARTIFACT. */
  readonly errorCode?: ErrorCode;
  /** Hint shown when the body does not match its schema. */
  readonly hint?: string;
}

export function defineDocument<S extends z.ZodType>(
  kind: string,
  definition: DocumentDefinition<S>,
): VersionedDocument<z.output<S>> {
  const history = definition.history ?? [];
  const latestVersion: DocumentVersion = definition.upgrade
    ? { schema: definition.latest, fromPrevious: definition.upgrade }
    : { schema: definition.latest };
  const versions: readonly DocumentVersion[] = [...history, latestVersion];
  const latest = definition.latest;
  const current = versions.length;
  for (let v = 2; v <= current; v++) {
    if (!versions[v - 1]?.fromPrevious) {
      throw new MetatorError("INTERNAL", `defineDocument(${kind}): v${v} needs a migration from v${v - 1}`);
    }
  }

  const code = definition.errorCode ?? "INVALID_ARTIFACT";
  const invalid = (source: string, message: string, hint?: string, details?: Record<string, unknown>) =>
    err(
      new MetatorError(code, `${source}: ${message}`, {
        ...(hint === undefined ? {} : { hint }),
        details: { source, kind, ...details },
      }),
    );

  const issuesOf = (error: z.ZodError) =>
    error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message }));

  return {
    kind,
    current,

    parse(raw: unknown, source: string): Result<z.output<S>, MetatorError> {
      const header = HeaderSchema.safeParse(raw);
      if (!header.success) {
        return invalid(
          source,
          "missing document header (kind, schemaVersion)",
          `Expected "kind: ${kind}" and "schemaVersion: ${current}" at the top of the document.`,
        );
      }
      const { kind: actualKind, schemaVersion } = header.data;
      if (actualKind !== kind) return invalid(source, `expected kind "${kind}", found "${actualKind}"`);
      if (schemaVersion > current) {
        return invalid(
          source,
          `schemaVersion ${schemaVersion} is newer than supported (${current})`,
          "This file was written by a newer MetatorAI. Upgrade metator-ai to read it.",
        );
      }
      if (schemaVersion < 1) return invalid(source, `unsupported schemaVersion ${schemaVersion}`);

      const { kind: _k, schemaVersion: _v, ...rest } = raw as Record<string, unknown>;
      const first = (versions[schemaVersion - 1] as DocumentVersion).schema.safeParse(rest);
      if (!first.success) {
        return invalid(
          source,
          `does not match ${kind} v${schemaVersion}: ${first.error.issues[0]?.message}`,
          definition.hint,
          {
            schemaVersion,
            issues: issuesOf(first.error),
          },
        );
      }

      let body: unknown = first.data;
      for (let v = schemaVersion + 1; v <= current; v++) {
        const step = versions[v - 1] as DocumentVersion;
        const migrated = step.schema.safeParse((step.fromPrevious as (p: unknown) => unknown)(body));
        if (!migrated.success) {
          return invalid(
            source,
            `migration ${kind} v${v - 1} → v${v} produced an invalid document`,
            undefined,
            {
              issues: issuesOf(migrated.error),
            },
          );
        }
        body = migrated.data;
      }
      return ok(body as z.output<S>);
    },

    stamp(body: z.output<S>): DocumentHeader & z.output<S> {
      return { kind, schemaVersion: current, ...(body as object) } as DocumentHeader & z.output<S>;
    },

    jsonSchema(io: "input" | "output" = "input"): Record<string, unknown> {
      const bodySchema = z.toJSONSchema(latest, { io }) as Record<string, unknown> & {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      return {
        ...bodySchema,
        properties: {
          kind: { const: kind },
          schemaVersion: { const: current },
          ...bodySchema.properties,
        },
        required: ["kind", "schemaVersion", ...(bodySchema.required ?? [])],
      };
    },
  };
}

// ── Serialization helpers shared by every document kind ──────────────────────────

export function parseJsonDocument(text: string, source: string): Result<unknown, MetatorError> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (e) {
    return err(new MetatorError("INVALID_ARTIFACT", `${source} is not valid JSON: ${(e as Error).message}`));
  }
}

export function parseYamlDocument(text: string, source: string): Result<unknown, MetatorError> {
  try {
    return ok(parseYaml(text) as unknown);
  } catch (e) {
    return err(
      new MetatorError("INVALID_CONFIG", `Invalid YAML in ${source}: ${(e as Error).message}`, {
        details: { source },
      }),
    );
  }
}

export function serializeJsonDocument(doc: object): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;

/** Markdown documents carry their header as YAML front matter. */
export function renderFrontMatter(header: object, body: string): string {
  return `---\n${stringifyYaml(header, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

export function readFrontMatter(text: string, source: string): Result<unknown, MetatorError> {
  const match = FRONT_MATTER.exec(text);
  if (!match) {
    return err(
      new MetatorError("INVALID_ARTIFACT", `${source}: missing front matter with kind and schemaVersion`, {
        details: { source },
      }),
    );
  }
  try {
    return ok(parseYaml(match[1] as string) as unknown);
  } catch (e) {
    return err(
      new MetatorError("INVALID_ARTIFACT", `${source}: invalid front matter: ${(e as Error).message}`),
    );
  }
}
