import { describe, expect, test } from "bun:test";
import { err, MetatorError, ok } from "@metator/core";
import { serialize, toEnvelope } from "../src/envelope.ts";

describe("envelope edge cases", () => {
  test("byte budget counts UTF-8 bytes, not characters", () => {
    const data = Array.from({ length: 200 }, () => "żółć ✕ → 日本");
    const text = serialize({ ok: true, data }, 1024);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1024);
    expect(JSON.parse(text).truncated).toBe(true);
  });

  test("keeps an existing `next` hint when truncating", () => {
    const data = Array.from({ length: 300 }, (_, i) => `file-${i}`);
    const parsed = JSON.parse(serialize({ ok: true, data, next: "use --package billing" }, 512));
    expect(parsed.next).toBe("use --package billing");
  });

  test("non-array payloads are never mangled, even when large", () => {
    const big = { text: "x".repeat(20_000) };
    expect(JSON.parse(serialize({ ok: true, data: big }, 1024)).data).toEqual(big);
  });

  test("a single oversized item is kept rather than emitting an empty result", () => {
    const parsed = JSON.parse(serialize({ ok: true, data: ["y".repeat(5000)] }, 1024));
    expect(parsed.data).toHaveLength(1);
  });

  test("warnings are omitted when empty and kept on failure envelopes", () => {
    expect(toEnvelope(ok(1))).toEqual({ ok: true, data: 1 });
    expect(toEnvelope(err(new MetatorError("INTERNAL", "x")), ["degraded"]).warnings).toEqual(["degraded"]);
  });
});
