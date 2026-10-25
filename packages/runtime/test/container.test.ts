import { describe, expect, test } from "bun:test";
import type { Clock, Logger } from "@metator/core";
import { asFunction, asValue } from "awilix";
import { createMetatorContainer, resolvePort } from "../src/container.ts";

const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });
const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {} };

describe("Metator container (awilix)", () => {
  test("resolves lazily and caches singletons", () => {
    let created = 0;
    const c = createMetatorContainer();
    c.register({
      clock: asFunction(() => {
        created++;
        return fixedClock("2026-01-01T00:00:00Z");
      }).singleton(),
    });
    expect(created).toBe(0);
    expect(c.resolve("clock")).toBe(c.resolve("clock"));
    expect(created).toBe(1);
  });

  test("injects ports into factories through the typed cradle", () => {
    const c = createMetatorContainer();
    c.register({
      clock: asValue(fixedClock("2026-05-01T10:00:00Z")),
      logger: asFunction(
        ({ clock }: { clock: Clock }): Logger => ({
          ...silentLogger,
          info: () => void clock.now(),
        }),
      ).singleton(),
    });
    expect(typeof c.resolve("logger").info).toBe("function");
  });

  test("re-registering overrides the default (config > preset > default)", () => {
    const c = createMetatorContainer();
    c.register({ clock: asValue(fixedClock("2020-01-01T00:00:00Z")) });
    c.register({ clock: asValue(fixedClock("2030-01-01T00:00:00Z")) });
    expect(c.resolve("clock").now().getUTCFullYear()).toBe(2030);
  });

  test("a scope per run sees its own values without leaking into the root", () => {
    const root = createMetatorContainer();
    root.register({ clock: asValue(fixedClock("2026-01-01T00:00:00Z")) });
    const run = root.createScope();
    run.register({ clock: asValue(fixedClock("2026-12-31T00:00:00Z")) });
    expect(run.resolve("clock").now().getUTCMonth()).toBe(11);
    expect(root.resolve("clock").now().getUTCMonth()).toBe(0);
  });

  test("missing port becomes BINDING_MISSING with an actionable hint", () => {
    const result = resolvePort(createMetatorContainer(), "vcs");
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe("BINDING_MISSING");
    expect(error.hint).toContain("metator.config");
  });

  test("dependency cycles are reported, not stack-overflowed", () => {
    const c = createMetatorContainer();
    c.register({
      clock: asFunction(({ logger }: { logger: Logger }) => logger as unknown as Clock),
      logger: asFunction(({ clock }: { clock: Clock }) => clock as unknown as Logger),
    });
    const error = resolvePort(c, "clock")._unsafeUnwrapErr();
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toContain("cycle");
  });

  test("resolvePort returns the instance on success", () => {
    const c = createMetatorContainer();
    const clock = fixedClock("2026-01-01T00:00:00Z");
    c.register({ clock: asValue(clock) });
    expect(resolvePort(c, "clock")._unsafeUnwrap()).toBe(clock);
  });
});
