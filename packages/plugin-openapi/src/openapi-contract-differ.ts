import {
  type ContractChange,
  type ContractComparison,
  type ContractDiffer,
  err,
  MetatorError,
  ok,
  type Result,
} from "@metator/core";
import { parse } from "yaml";

type Side = { readonly path: string; readonly text: string };
type Doc = Record<string, unknown>;

const object = (v: unknown): Doc | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : undefined;

/** A parsed OpenAPI 3.x or Swagger 2 document with its version, or why the text is not one. */
function readSpec(side: Side): Result<{ doc: Doc; swagger: boolean; version?: string }, MetatorError> {
  const fail = (why: string) =>
    err(
      new MetatorError("PARSE_FAILED", `${side.path}: ${why}`, {
        hint: "Both versions must be OpenAPI 3.x or Swagger 2 specifications (YAML or JSON).",
      }),
    );
  let doc: Doc | undefined;
  try {
    doc = object(parse(side.text));
  } catch (e) {
    return fail(`not YAML or JSON (${(e as Error).message.split("\n")[0]})`);
  }
  if (!doc) return fail("not a document");
  const swagger = String(doc.swagger ?? "") === "2.0";
  if (!swagger && !/^3\.\d/.test(String(doc.openapi ?? "")))
    return fail('neither `openapi: 3.x` nor `swagger: "2.0"`');
  if (doc.paths !== undefined && !object(doc.paths)) return fail("`paths` is not an object");
  const version = object(doc.info)?.version;
  return ok({
    doc,
    swagger,
    ...(typeof version === "string" || typeof version === "number" ? { version: String(version) } : {}),
  });
}

/** What the change is about, from where it is: a path, an operation, a parameter, a body. */
function subject(path: readonly (string | number)[]): string {
  if (path[0] !== "paths") return "spec";
  if (path.length === 2) return "path";
  if (path.length === 3) return "operation";
  if (path.includes("parameters")) return "parameter";
  if (path.includes("requestBody")) return "request.body";
  if (path.includes("responses")) return "response";
  return "operation";
}

/**
 * A changed `type` is breaking for consumers unless it widens what they may send (integer →
 * number in a request) or narrows what they receive (number → integer in a response).
 * api-smart-diff counts every type replacement as non-breaking.
 */
function typeChange(path: readonly (string | number)[], before: unknown, after: unknown): boolean {
  const request = path.includes("parameters") || path.includes("requestBody");
  const response = path.includes("responses");
  if (!request && !response) return false;
  return request
    ? !(before === "integer" && after === "number")
    : !(before === "number" && after === "integer");
}

/**
 * What a consumer feels. `components` are compared where `paths` use them (through `$ref`s),
 * so their own entries would count each change twice; `info`, `tags` and docs are not the API.
 */
const SURFACE = new Set(["paths", "webhooks", "security", "servers"]);

const SEVERITY = {
  breaking: "breaking",
  "non-breaking": "non-breaking",
  annotation: "non-breaking",
  deprecated: "non-breaking",
  unclassified: "unclassified",
} as const;

/**
 * OpenAPI 3.0, 3.1 and Swagger 2 compared by api-smart-diff (ADR-0073): paths, operations,
 * parameters (added, removed, required), request and response bodies through `$ref`s, each
 * change classified. Swagger 2 is converted to OpenAPI 3 first (swagger2openapi). Both are
 * loaded on first use and given documents, never URLs, so nothing is fetched.
 */
export class OpenApiContractDiffer implements ContractDiffer {
  readonly kind = "openapi";

  async compare(before: Side, after: Side): Promise<Result<ContractComparison, MetatorError>> {
    const a = readSpec(before);
    if (a.isErr()) return err(a.error);
    const b = readSpec(after);
    if (b.isErr()) return err(b.error);
    try {
      const { apiDiff } = await import("api-smart-diff");
      const [from, to] = await Promise.all([openapi3(a.value), openapi3(b.value)]);
      const changes: ContractChange[] = apiDiff(from, to)
        .filter((d) => SURFACE.has(String(d.path[0])))
        .map((d) => {
          const location = d.path.join(".");
          const breaking =
            d.type === "non-breaking" &&
            d.action === "replace" &&
            d.path.at(-1) === "type" &&
            typeChange(d.path, d.before, d.after);
          return {
            code: `${subject(d.path)}.${d.action}`,
            severity: breaking ? "breaking" : SEVERITY[d.type],
            location,
            message: d.description ?? `${d.action} ${location}`,
          };
        });
      return ok({
        changes,
        versions: {
          ...(a.value.version ? { before: a.value.version } : {}),
          ...(b.value.version ? { after: b.value.version } : {}),
        },
      });
    } catch (e) {
      return err(
        new MetatorError(
          "PARSE_FAILED",
          `cannot compare ${after.path}: ${(e as Error).message.split("\n")[0]}`,
        ),
      );
    }
  }
}

async function openapi3(spec: { doc: Doc; swagger: boolean }): Promise<Doc> {
  if (!spec.swagger) return spec.doc;
  const { default: converter } = await import("swagger2openapi");
  // External `$ref`s stay unresolved (no `resolve` option): the conversion reads nothing else.
  const out = await converter.convertObj(structuredClone(spec.doc) as never, { patch: true, warnOnly: true });
  return out.openapi as unknown as Doc;
}
