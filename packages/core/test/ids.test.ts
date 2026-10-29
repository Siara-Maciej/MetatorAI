import { describe, expect, test } from "bun:test";
import { canonical, digestOf, fnv1a, planId, slug } from "../src/domain/ids.ts";

describe("ids and digests", () => {
  test("slugs: ASCII words, letters without a decomposition mapped, a maximum, a fallback", () => {
    expect(slug("Złamać ŁÓDŹ, straße!", 40, "x")).toBe("zlamac-lodz-strasse");
    expect(slug("a".repeat(10), 4, "x")).toBe("aaaa");
    expect(slug("one two", 4, "x")).toBe("one");
    expect(slug("???", 10, "fallback")).toBe("fallback");
    expect(planId("Rename refunds")).toBe("rename-refunds");
  });

  test("canonical text sorts keys and drops undefined, so a digest is about the data only", () => {
    expect(canonical({ b: 1, a: [true, null, 'x"y'], c: undefined })).toBe('{"a":[true,null,"x\\"y"],"b":1}');
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toMatch(/^[0-9a-f]{8}$/);
  });
});
