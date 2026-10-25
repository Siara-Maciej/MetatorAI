export type Severity = "error" | "warning" | "info";

/** Normalized diagnostic: every linter, type checker and rule engine maps to this shape. */
export interface Diagnostic {
  readonly source: string;
  readonly toolRuleId?: string;
  /** Project canon rule, e.g. "MT-ARCH-003", resolved from the rule registry. */
  readonly canonRuleId?: string;
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: Severity;
  readonly message: string;
}

export type QualityCapability = "lint" | "format" | "typecheck" | "rules";

export interface DiagnosticReport {
  readonly capability: QualityCapability;
  readonly provider: string;
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly durationMs: number;
}
