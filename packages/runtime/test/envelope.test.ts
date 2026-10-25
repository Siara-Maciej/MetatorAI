import { describe, expect, test } from "bun:test";
import { err, MetatorError, ok } from "@metator/core";
import { EXIT, exitCodeFor, fromUnknown, serialize, toEnvelope } from "../src/envelope.ts";

describe("envelope", () => {
  test("success carries data and warnings", () => {
    expect(toEnvelope(ok([1, 2]), ["index older than 1 day"])).toEqual({
      ok: true,
      data: [1, 2],
      warnings: ["index older than 1 day"],
    });
  });

  test("failure carries code, message and hint, never a stack", () => {
    const env = toEnvelope(err(MetatorError.usage("Unknown command: foo", "Run `metator help`.")));
    expect(env).toEqual({
      ok: false,
      error: { code: "USAGE", message: "Unknown command: foo", hint: "Run `metator help`." },
    });
  });

  test("exit codes map from error codes", () => {
    expect(exitCodeFor(MetatorError.usage("x"))).toBe(EXIT.USAGE);
    expect(exitCodeFor(new MetatorError("STALE_INDEX", "x"))).toBe(EXIT.STALE_INDEX);
    expect(exitCodeFor(new MetatorError("COMMAND_FAILED", "x"))).toBe(EXIT.FAIL);
  });

  test("unknown throwables become INTERNAL errors", () => {
    expect(fromUnknown(new Error("boom")).code).toBe("INTERNAL");
    expect(fromUnknown("boom").message).toBe("boom");
  });

  test("serialize truncates array payloads to the byte budget", () => {
    const data = Array.from({ length: 500 }, (_, i) => ({ file: `packages/a/src/file-${i}.ts` }));
    const text = serialize({ ok: true, data }, 2048);
    const parsed = JSON.parse(text);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(2048);
    expect(parsed.truncated).toBe(true);
    expect(parsed.next).toContain("Narrow");
    expect(parsed.data.length).toBeGreaterThan(0);
  });

  test("serialize leaves small payloads untouched", () => {
    expect(JSON.parse(serialize({ ok: true, data: [1] }))).toEqual({ ok: true, data: [1] });
  });
});
