export type ErrorCode =
  | "USAGE"
  | "NOT_FOUND"
  | "INVALID_ARTIFACT"
  | "INVALID_CONFIG"
  | "COMMAND_FAILED"
  | "BIN_NOT_FOUND"
  | "STALE_INDEX"
  | "TRANSITION_DENIED"
  | "PARSE_FAILED"
  | "CHECK_FAILED"
  /** A write based on a stale `digest`: someone changed the document since; `details.current` is it now. */
  | "CONFLICT"
  /** A gate that waits on other work (a system run's children): not yet, look again later (exit 4). */
  | "WAITING"
  /** A gate that waits on work that stopped (a child run escalated): no retry passes it (exit 3). */
  | "BLOCKED"
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

  /** `what` was not found; a `hint` in `extra` is the hint, everything else is details. */
  static notFound(what: string, extra?: Record<string, unknown> & { readonly hint?: string }): MetatorError {
    const { hint, ...details } = extra ?? {};
    return new MetatorError("NOT_FOUND", `${what} not found`, {
      ...(typeof hint === "string" ? { hint } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    });
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
