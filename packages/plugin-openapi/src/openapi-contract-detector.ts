import {
  type ContractDetector,
  type DetectedContract,
  type MetatorError,
  ok,
  type Result,
} from "@metator/core";
import { parse } from "yaml";

const object = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** OpenAPI 3 (`openapi: 3.x`) and Swagger 2 (`swagger: "2.0"`) specifications, YAML or JSON. */
export class OpenApiContractDetector implements ContractDetector {
  readonly kind = "openapi";
  readonly globs = ["**/*.{yaml,yml,json}"];

  detect(path: string, text: string): Result<DetectedContract | undefined, MetatorError> {
    if (!/\b(openapi|swagger)\b/.test(text.slice(0, 4000))) return ok(undefined);
    let doc: Record<string, unknown> | undefined;
    try {
      doc = object(parse(text));
    } catch {
      return ok(undefined); // not YAML or JSON: not a specification
    }
    const version = doc?.openapi ?? doc?.swagger;
    if (typeof version !== "string" && typeof version !== "number") return ok(undefined);
    if (!/^(3\.|2\.0)/.test(String(version))) return ok(undefined);
    const info = object(doc?.info);
    const servers = Array.isArray(doc?.servers)
      ? doc.servers.flatMap((s) => (typeof object(s)?.url === "string" ? [object(s)?.url as string] : []))
      : typeof doc?.host === "string"
        ? [
            `${(Array.isArray(doc.schemes) ? doc.schemes[0] : "https") ?? "https"}://${doc.host}${typeof doc.basePath === "string" ? doc.basePath : ""}`,
          ]
        : [];
    return ok({
      path,
      title: typeof info?.title === "string" && info.title.trim() ? info.title.trim() : path,
      ...(typeof info?.version === "string" || typeof info?.version === "number"
        ? { version: String(info.version) }
        : {}),
      servers,
    });
  }
}
