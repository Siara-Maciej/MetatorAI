import { describe, expect, test } from "bun:test";
import { MetatorError } from "@metator/core";
import { Container, token } from "../src/container.ts";

const A = token<{ id: number }>("A");
const B = token<{ a: { id: number } }>("B");
const Plugins = token<string>("Plugins");

describe("Container", () => {
  test("resolves lazily and caches singletons", () => {
    let created = 0;
    const c = new Container().register(A, () => ({ id: ++created }));
    expect(created).toBe(0);
    expect(c.resolve(A)).toBe(c.resolve(A));
    expect(created).toBe(1);
  });

  test("injects dependencies through factories", () => {
    const c = new Container().register(A, () => ({ id: 7 })).register(B, (k) => ({ a: k.resolve(A) }));
    expect(c.resolve(B).a.id).toBe(7);
  });

  test("rejects duplicate registration, allows explicit override", () => {
    const c = new Container().register(A, () => ({ id: 1 }));
    expect(() => c.register(A, () => ({ id: 2 }))).toThrow(MetatorError);
    c.resolve(A);
    c.override(A, () => ({ id: 3 }));
    expect(c.resolve(A).id).toBe(3);
  });

  test("missing binding gives an actionable error", () => {
    try {
      new Container().resolve(A);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MetatorError);
      expect((e as MetatorError).code).toBe("BINDING_MISSING");
      expect((e as MetatorError).hint).toContain("metator.config");
    }
  });

  test("detects dependency cycles with the full chain", () => {
    const X = token<unknown>("X");
    const Y = token<unknown>("Y");
    const c = new Container().register(X, (k) => k.resolve(Y)).register(Y, (k) => k.resolve(X));
    expect(() => c.resolve(X)).toThrow("Dependency cycle: X -> Y -> X");
  });

  test("multi-bindings resolve in registration order", () => {
    const c = new Container().registerMany(Plugins, () => "biome").registerMany(Plugins, () => "ast-grep");
    expect(c.resolveAll(Plugins)).toEqual(["biome", "ast-grep"]);
    expect(new Container().resolveAll(Plugins)).toEqual([]);
  });
});
