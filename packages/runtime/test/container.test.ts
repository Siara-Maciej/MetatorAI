import { describe, expect, test } from "bun:test";
import { type Clock, err, MetatorError, ok } from "@metator/core";
import { asFunction, asValue } from "awilix";
import { bootstrap, checkoutRoots, orderedHosts, workNotes } from "../src/bootstrap.ts";
import { createMetatorContainer } from "../src/container.ts";

const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

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
      timer: asFunction(({ clock }: { clock: Clock }) => ({
        sleep: async () => void clock.now(),
      })).singleton(),
    });
    expect(typeof c.resolve("timer").sleep).toBe("function");
  });

  test("re-registering overrides the default (config > preset > default)", () => {
    const c = createMetatorContainer();
    c.register({ clock: asValue(fixedClock("2020-01-01T00:00:00Z")) });
    c.register({ clock: asValue(fixedClock("2030-01-01T00:00:00Z")) });
    expect(c.resolve("clock").now().getUTCFullYear()).toBe(2030);
  });
});

describe("bootstrap", () => {
  test("every git port is the one GitVcs, so they agree on what a change is", () => {
    const c = bootstrap({ root: "/repo" });
    const git = c.resolve("git");
    for (const port of ["vcs", "revisionReader", "changeHistory", "branchHistory", "changePatch"] as const)
      expect(c.resolve(port) as unknown).toBe(git);
  });
});

describe("workNotes", () => {
  test("a Node project without node_modules is told its tools cannot run; an installed one is not", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "metator-notes-"));
    expect(workNotes(dir)).toEqual([]);
    // Nothing to install: no node_modules is not a missing install (F5).
    await writeFile(join(dir, "package.json"), "{}");
    expect(workNotes(dir)).toEqual([]);
    await writeFile(join(dir, "package.json"), '{"devDependencies":{"vitest":"3"}}');
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

describe("orderedHosts", () => {
  test("follows supervisor.hostOrder; hosts it does not name come last in their own order", () => {
    const hosts = [{ id: "opencode" }, { id: "claude" }, { id: "copilot" }, { id: "other" }];
    expect(orderedHosts(["copilot", "claude", "opencode"], hosts).map((h) => h.id)).toEqual([
      "copilot",
      "claude",
      "opencode",
      "other",
    ]);
    expect(orderedHosts(["claude"], hosts).map((h) => h.id)).toEqual([
      "claude",
      "opencode",
      "copilot",
      "other",
    ]);
  });
});
