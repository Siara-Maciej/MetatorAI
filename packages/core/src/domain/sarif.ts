import type { Diagnostic, Severity } from "./diagnostic.ts";
import { normalizePath } from "./glob.ts";

/**
 * SARIF 2.1.0 (ADR-0003): the interchange format every tool adapter prefers when the tool can
 * emit it, so one mapping covers Biome, ESLint, Semgrep, CodeQL and others. Only the fields
 * MetatorAI reads are typed.
 */
export interface SarifLog {
  readonly version?: string;
  readonly runs?: readonly SarifRun[];
}

interface SarifRun {
  readonly tool?: { readonly driver?: { readonly name?: string } };
  readonly results?: readonly SarifResult[];
}

interface SarifResult {
  readonly ruleId?: string;
  readonly level?: "error" | "warning" | "note" | "none";
  readonly message?: { readonly text?: string };
  readonly locations?: readonly {
    readonly physicalLocation?: {
      readonly artifactLocation?: { readonly uri?: string };
      readonly region?: { readonly startLine?: number; readonly startColumn?: number };
    };
  }[];
}

const LEVEL: Readonly<Record<string, Severity>> = {
  error: "error",
  warning: "warning",
  note: "info",
  none: "info",
};

/** Maps SARIF results to diagnostics with repo-relative paths (absolute and file:// URIs included). */
export function diagnosticsFromSarif(log: SarifLog, root: string, source: string): Diagnostic[] {
  const base = `${normalizePath(root).replace(/\/$/, "")}/`;
  const relative = (uri: string) => {
    const path = normalizePath(decodeURIComponent(uri.replace(/^file:\/\//, "")));
    return path.startsWith(base) ? path.slice(base.length) : path;
  };
  const out: Diagnostic[] = [];
  for (const run of log.runs ?? []) {
    for (const r of run.results ?? []) {
      const location = r.locations?.[0]?.physicalLocation;
      const uri = location?.artifactLocation?.uri;
      if (!uri) continue;
      out.push({
        source,
        ...(r.ruleId ? { toolRuleId: r.ruleId } : {}),
        file: relative(uri),
        ...(location?.region?.startLine ? { line: location.region.startLine } : {}),
        ...(location?.region?.startColumn ? { column: location.region.startColumn } : {}),
        severity: LEVEL[r.level ?? "warning"] ?? "warning",
        message: r.message?.text ?? r.ruleId ?? "finding",
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
  );
}
