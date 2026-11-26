import { type ErrorCode, MetatorError, type Result } from "@metator/core";

/** The one output contract for every `metator` command consumed by agents, hooks and CI. */
export interface Envelope<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly warnings?: readonly string[];
  readonly truncated?: boolean;
  readonly next?: string;
  readonly error?: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly hint?: string;
    /** Machine-readable specifics (validation issues, paths, stderr) agents need to fix the problem. */
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export const EXIT = { OK: 0, FAIL: 1, BLOCKED: 3, WAITING: 4, USAGE: 64, STALE_INDEX: 65 } as const;

export function exitCodeFor(error: MetatorError): number {
  if (error.code === "USAGE" || error.code === "AMBIGUOUS") return EXIT.USAGE;
  if (error.code === "STALE_INDEX") return EXIT.STALE_INDEX;
  // A gate that waits (W13): the drive tells "not yet" from "stopped for good" by these.
  if (error.code === "WAITING") return EXIT.WAITING;
  if (error.code === "BLOCKED") return EXIT.BLOCKED;
  return EXIT.FAIL;
}

export function toEnvelope<T>(
  result: Result<T, MetatorError>,
  warnings: readonly string[] = [],
): Envelope<T> {
  const extra = warnings.length > 0 ? { warnings } : {};
  if (result.isOk()) return { ok: true, data: result.value, ...extra };
  const { code, message, hint, details } = result.error;
  return {
    ok: false,
    error: {
      code,
      message,
      ...(hint === undefined ? {} : { hint }),
      ...(details === undefined ? {} : { details }),
    },
    ...extra,
  };
}

export function fromUnknown(e: unknown): MetatorError {
  if (e instanceof MetatorError) return e;
  return new MetatorError("INTERNAL", e instanceof Error ? e.message : String(e));
}

/** What a cut answer says when its command named no way of its own to narrow it. */
const NARROW_HINT = "Narrow the query with the command's own options (`--help` lists them).";

/**
 * Serializes an envelope within a byte budget. Array payloads are halved until they fit,
 * and the envelope is flagged `truncated` with a hint on how to narrow the query: the
 * envelope's own `next`, else the command's (`narrow`: its options that narrow, by name).
 */
export function serialize<T>(envelope: Envelope<T>, maxBytes = 8 * 1024, narrow = NARROW_HINT): string {
  let current: Envelope<unknown> = envelope;
  let text = JSON.stringify(current);
  while (byteLength(text) > maxBytes && Array.isArray(current.data) && current.data.length > 1) {
    current = {
      ...current,
      data: current.data.slice(0, Math.ceil(current.data.length / 2)),
      truncated: true,
      next: current.next ?? narrow,
    };
    text = JSON.stringify(current);
  }
  return text;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
