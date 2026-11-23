import { describe, expect, test } from "bun:test";
import type { Clock } from "@metator/core";
import { asFunction, asValue } from "awilix";
import { bootstrap, orderedHosts } from "../src/bootstrap.ts";
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

  test("the import and the symbol analyzer are one analyzer of every language (oxc, Java)", () => {
    const c = bootstrap({ root: "/repo" });
    const analyzers = c.resolve("analyzers");
    expect(c.resolve("importAnalyzer") as unknown).toBe(analyzers);
    expect(c.resolve("symbolAnalyzer") as unknown).toBe(analyzers);
    expect(analyzers.extensions).toEqual([...c.resolve("oxc").extensions, ".java"]);
  });

  test("the contract kinds are the ones a differ compares", () => {
    const c = bootstrap({ root: "/repo" });
    expect(c.resolve("contractKinds")).toEqual(["openapi"]);
    expect(c.resolve("contractKinds")).toEqual(c.resolve("contractDiffers").map((d) => d.kind));
  });

  test("the adapters use cases are given are the registered ones, so a test container can replace them", () => {
    const c = bootstrap({ root: "/repo" });
    for (const key of [
      "ruleEngines",
      "toolBins",
      "containerRuntime",
      "mcpToolCaller",
      "codeHost",
      "reviewHost",
      "declarationEmitter",
      "coverageReader",
      "plannedBreakingChanges",
      "styleImports",
      "apiSnapshots",
      "diffCoverage",
      "diffContracts",
      "architectureFacts",
    ] as const)
      expect(c.resolve(key)).toBeDefined();
    expect(c.resolve("ruleEngines").map((e) => e.engine)).toEqual(["ast-grep", "biome", "tsc", "test"]);
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
