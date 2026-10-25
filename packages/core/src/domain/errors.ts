export type ErrorCode =
  | "USAGE"
  | "NOT_FOUND"
  | "INVALID_ARTIFACT"
  | "INVALID_CONFIG"
  | "COMMAND_FAILED"
  | "BIN_NOT_FOUND"
  | "STALE_INDEX"
  | "TRANSITION_DENIED"
  | "BINDING_MISSING"
  | "INTERNAL";

export interface MetatorErrorInit {
  readonly hint?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** The single error type crossing layer boundaries. One mapping to the CLI envelope (DRY). */
export class MetatorError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, init: MetatorErrorInit = {}) {
    super(message);
    this.name = "MetatorError";
    this.code = code;
    this.hint = init.hint;
    this.details = init.details;
  }

  static usage(message: string, hint?: string): MetatorError {
    return new MetatorError("USAGE", message, hint === undefined ? {} : { hint });
  }

  static notFound(what: string, details?: Record<string, unknown>): MetatorError {
    return new MetatorError("NOT_FOUND", `${what} not found`, details === undefined ? {} : { details });
  }

  toJSON(): { code: ErrorCode; message: string; hint?: string; details?: Readonly<Record<string, unknown>> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
