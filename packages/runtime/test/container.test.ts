import { describe, expect, test } from "bun:test";
import { type Clock, err, type Logger, MetatorError, ok } from "@metator/core";
import { asFunction, asValue } from "awilix";
import { checkoutRoots, workNotes } from "../src/bootstrap.ts";
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

describe("workNotes", () => {
  test("a Node project without node_modules is told its tools cannot run; an installed one is not", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "metator-notes-"));
    expect(workNotes(dir)).toEqual([]);
    await writeFile(join(dir, "package.json"), "{}");
    expect(workNotes(dir)[0]).toContain("dependencies are not installed");
    await mkdir(join(dir, "node_modules"));
    expect(workNotes(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("checkoutRoots", () => {
  test("the checkouts the map's applications are in; one not on this machine, or no map, adds none", async () => {
    const apps = [{ id: "api" }, { id: "web" }, { id: "gone" }];
    const roots: Record<string, string> = { api: "/f/api", web: "/f/front" };
    const sources = {
      location: { require: async () => ok({ applications: apps }) },
      locate: async (app: { id: string }) =>
        ok(roots[app.id] ? { app: app.id, root: roots[app.id], dir: ".", via: "local" } : undefined),
    } as unknown as Parameters<typeof checkoutRoots>[0];
    expect(await checkoutRoots(sources)).toEqual(["/f/api", "/f/front"]);
    const none = {
      location: { require: async () => err(new MetatorError("NOT_FOUND", "no map")) },
      locate: async () => ok(undefined),
    } as unknown as Parameters<typeof checkoutRoots>[0];
    expect(await checkoutRoots(none)).toEqual([]);
  });
});
