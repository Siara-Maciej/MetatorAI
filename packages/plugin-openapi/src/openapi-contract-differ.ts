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

/** The document's own fields, or undefined when the text is not YAML or JSON. */
function header(text: string): { format: "swagger2" | "openapi3"; version?: string } | undefined {
  try {
    const doc = parse(text) as { swagger?: unknown; info?: { version?: unknown } } | null;
    if (!doc || typeof doc !== "object") return undefined;
    const version = doc.info?.version;
    return {
      format: String(doc.swagger ?? "").startsWith("2") ? "swagger2" : "openapi3",
      ...(typeof version === "string" || typeof version === "number" ? { version: String(version) } : {}),
    };
  } catch {
    return undefined;
  }
}

const SEVERITY = {
  breaking: "breaking",
  "non-breaking": "non-breaking",
  unclassified: "unclassified",
} as const;

/**
 * OpenAPI 3 and Swagger 2 compared by `openapi-diff` (ADR-0069): paths, methods, status codes,
 * headers and request and response bodies, each classified breaking or not. Specifications are
 * passed as text, so nothing is fetched.
 */
export class OpenApiContractDiffer implements ContractDiffer {
  readonly kind = "openapi";

  async compare(before: Side, after: Side): Promise<Result<ContractComparison, MetatorError>> {
    const a = header(before.text);
    const b = header(after.text);
    if (!a || !b)
      return err(
        new MetatorError("PARSE_FAILED", `${(a ? after : before).path} is not a YAML or JSON specification`),
      );
    try {
      // Loaded on first use: it pulls in swagger-parser and friends, which every other command can skip.
      const { default: openApiDiff } = await import("openapi-diff");
      const outcome = await openApiDiff.diffSpecs({
        sourceSpec: { content: before.text, location: `${before.path} (before)`, format: a.format },
        destinationSpec: { content: after.text, location: `${after.path} (after)`, format: b.format },
      });
      const all = [
        ...(outcome.breakingDifferencesFound ? outcome.breakingDifferences : []),
        ...outcome.nonBreakingDifferences,
        ...outcome.unclassifiedDifferences,
      ];
      const changes: ContractChange[] = all.map((d) => {
        const location =
          d.destinationSpecEntityDetails[0]?.location ?? d.sourceSpecEntityDetails[0]?.location ?? "";
        return {
          code: d.code,
          severity: SEVERITY[d.type],
          location,
          message: `${d.action === "add" ? "added" : "removed"} ${d.entity.replaceAll(".", " ")} at ${location}`,
        };
      });
      return ok({
        changes,
        versions: { ...(a.version ? { before: a.version } : {}), ...(b.version ? { after: b.version } : {}) },
      });
    } catch (e) {
      return err(
        new MetatorError("PARSE_FAILED", (e as Error).message.split("\n")[0] ?? "openapi-diff failed", {
          hint: "Both versions must be valid OpenAPI 3.0 or Swagger 2 specifications.",
        }),
      );
    }
  }
}
