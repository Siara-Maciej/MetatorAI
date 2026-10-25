import { describe, expect, test } from "bun:test";
import { Container, token } from "../src/container.ts";

describe("Container edge cases", () => {
  test("override before first resolve replaces the default (config > preset > default)", () => {
    const Linter = token<string>("Linter");
    const c = new Container().register(Linter, () => "default").override(Linter, () => "biome");
    expect(c.resolve(Linter)).toBe("biome");
  });

  test("override after resolve drops the cached instance", () => {
    const N = token<{ v: number }>("N");
    const c = new Container().register(N, () => ({ v: 1 }));
    const first = c.resolve(N);
    c.override(N, () => ({ v: 2 }));
    expect(c.resolve(N)).not.toBe(first);
    expect(c.resolve(N).v).toBe(2);
  });

  test("has() reports single bindings only", () => {
    const S = token<number>("S");
    const M = token<number>("M");
    const c = new Container().register(S, () => 1).registerMany(M, () => 2);
    expect(c.has(S)).toBe(true);
    expect(c.has(M)).toBe(false);
  });

  test("a failing factory is not cached and can be retried", () => {
    const Flaky = token<string>("Flaky");
    let attempts = 0;
    const c = new Container().register(Flaky, () => {
      attempts++;
      if (attempts === 1) throw new Error("not ready");
      return "ready";
    });
    expect(() => c.resolve(Flaky)).toThrow("not ready");
    expect(c.resolve(Flaky)).toBe("ready");
  });

  test("resolution stack unwinds after an error (no false cycle reports)", () => {
    const A = token<string>("A");
    const B = token<string>("B");
    let fail = true;
    const c = new Container()
      .register(A, (k) => k.resolve(B))
      .register(B, () => {
        if (fail) throw new Error("boom");
        return "b";
      });
    expect(() => c.resolve(A)).toThrow("boom");
    fail = false;
    expect(c.resolve(A)).toBe("b");
  });

  test("tokens with the same description are distinct", () => {
    const one = token<number>("Same");
    const two = token<number>("Same");
    const c = new Container().register(one, () => 1).register(two, () => 2);
    expect([c.resolve(one), c.resolve(two)]).toEqual([1, 2]);
  });
});
