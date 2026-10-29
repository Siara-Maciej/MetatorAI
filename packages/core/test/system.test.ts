import { describe, expect, test } from "bun:test";
import { InMemoryCheckouts, InMemoryFileSystem } from "@metator/testing";
import { LintSystem, ShowSystem, SystemCatalog } from "../src/application/system.ts";
import { CloneCache, LocalSystemLocation, SystemSources } from "../src/application/system-sources.ts";
import { ok } from "../src/domain/result.ts";
import {
  contractUsers,
  deployWaves,
  lintSystemMap,
  parseConsumes,
  type SystemMap,
  SystemMapDocument,
} from "../src/domain/system-map.ts";

const MAP = `kind: SystemMap
schemaVersion: 1
system: billing-platform
applications:
  - id: web
    kind: frontend
    source: { path: apps/web }
    owners: ["@acme/web"]
    consumes: [billing-api@^2]
  - id: billing
    source: { path: services/billing }
    owners: ["@acme/billing"]
  - id: notifications
    source: { repo: github.com/acme/notifications, ref: v1.4.0 }
    consumes: [billing-api]
contracts:
  - id: billing-api
    kind: openapi
    owner: billing
    spec: { path: openapi.yaml }
`;
const FILES = {
  "docs/metator/system.yml": MAP,
  "apps/web/src/main.ts": "x",
  "services/billing/openapi.yaml": "openapi: 3.1.0",
};
const parse = (raw: object): SystemMap =>
  SystemMapDocument.parse({ kind: "SystemMap", schemaVersion: 1, ...raw }, "m")._unsafeUnwrap();
const app = (id: string, consumes: string[] = []) => ({ id, source: { path: id }, consumes });
const contract = (id: string, owner: string, kind = "openapi") => ({
  id,
  kind,
  owner,
  spec: { path: "s.yaml" },
});

describe("SystemMap", () => {
  test("defaults: kind service, no owners, providers-first and expand-contract", () => {
    const m = parse({ system: "s", applications: [{ id: "a", source: { path: "a" } }] });
    expect([m.applications[0]?.kind, m.applications[0]?.owners, m.contracts, m.policies]).toEqual([
      "service",
      [],
      [],
      { deployOrder: "providers-first", breaking: "expand-contract" },
    ]);
  });

  test("a source is a local path or another repository; a consumed entry is contract[@range]", () => {
    expect(
      SystemMapDocument.parse(
        { kind: "SystemMap", schemaVersion: 1, system: "s", applications: [] },
        "m",
      ).isErr(),
    ).toBe(true);
    const bad = { system: "s", applications: [{ id: "a", source: { url: "x" }, consumes: ["Bad Name"] }] };
    expect(SystemMapDocument.parse({ kind: "SystemMap", schemaVersion: 1, ...bad }, "m").isErr()).toBe(true);
    expect(parseConsumes("billing-api@^2")).toEqual({ contract: "billing-api", version: "^2" });
    expect(parseConsumes("billing-api")).toEqual({ contract: "billing-api" });
  });
});

describe("lintSystemMap", () => {
  test("unknown owners, contracts and kinds, duplicates and self-consumption", () => {
    const m = parse({
      system: "s",
      applications: [app("a", ["x-api", "a-api"]), app("a"), app("b", ["ghost"])],
      contracts: [contract("a-api", "a"), contract("x-api", "nobody"), contract("x-api", "b", "asyncapi")],
    });
    expect(lintSystemMap(m, ["openapi"]).map((p) => [p.severity, p.message])).toEqual([
      ["error", 'duplicate application "a"'],
      ["error", 'contract "x-api": owner "nobody" is not an application'],
      ["error", 'duplicate contract "x-api"'],
      ["error", 'contract "x-api": kind "asyncapi" has no plugin (supported: openapi)'],
      ["warning", '"a" consumes its own contract "a-api"'],
      ["error", '"b" consumes unknown contract "ghost"'],
    ]);
    expect(lintSystemMap(m, [])[3]?.message).toContain("(supported: none)");
  });

  test("a deploy cycle breaks providers-first; with deployOrder none it is allowed", () => {
    const raw = {
      system: "s",
      applications: [app("a", ["b-api"]), app("b", ["a-api"])],
      contracts: [contract("a-api", "a"), contract("b-api", "b")],
    };
    expect(lintSystemMap(parse(raw), ["openapi"]).map((p) => p.message)).toEqual([
      "deploy cycle: a → b (providers-first cannot order it)",
    ]);
    expect(lintSystemMap(parse({ ...raw, policies: { deployOrder: "none" } }), ["openapi"])).toEqual([]);
  });
});

describe("deploy order and contract users", () => {
  test("providers deploy first; independent applications share a wave", () => {
    const m = parse({
      system: "s",
      applications: [
        app("web", ["gw-api"]),
        app("gateway", ["billing-api", "users-api"]),
        app("billing"),
        app("users"),
        app("docs"),
      ],
      contracts: [
        contract("gw-api", "gateway"),
        contract("billing-api", "billing"),
        contract("users-api", "users"),
      ],
    });
    expect(deployWaves(m)).toEqual([["billing", "docs", "users"], ["gateway"], ["web"]]);
    expect(contractUsers(m).map((c) => [c.contract, c.owner, c.consumers])).toEqual([
      ["gw-api", "gateway", ["web"]],
      ["billing-api", "billing", ["gateway"]],
      ["users-api", "users", ["gateway"]],
    ]);
  });

  test("a cycle has no order; a consumed contract without a known provider adds no edge", () => {
    const cyclic = parse({
      system: "s",
      applications: [app("a", ["b-api"]), app("b", ["a-api"])],
      contracts: [contract("a-api", "a"), contract("b-api", "b")],
    });
    expect(deployWaves(cyclic)).toBeUndefined();
    const self = parse({
      system: "s",
      applications: [app("a", ["a-api", "ghost"])],
      contracts: [contract("a-api", "a")],
    });
    expect(deployWaves(self)).toEqual([["a"]]);
  });
});

describe("LintSystem and ShowSystem", () => {
  const world = (files: Record<string, string> = FILES) => {
    const fs = new InMemoryFileSystem(files);
    const location = new LocalSystemLocation(new SystemCatalog(fs, "docs/metator/system.yml"), "/r");
    const checkouts = new InMemoryCheckouts({ "/r": fs });
    const cloner = { resolve: async () => ok("a".repeat(40)), checkout: async () => ok(undefined) };
    const sources = new SystemSources(undefined, "/r", location, new CloneCache(cloner, "/c"), checkouts, {
      remoteUrl: async () => ok(undefined),
    });
    return { fs, lint: new LintSystem(sources, fs, ["openapi"], checkouts), show: new ShowSystem(location) };
  };

  test("a valid map: local directories and specifications exist; other repositories are listed as unchecked", async () => {
    expect((await world().lint.execute())._unsafeUnwrap()).toEqual({
      source: "docs/metator/system.yml",
      mapped: true,
      problems: [],
      unchecked: [],
    });
    const remote = MAP.replace(
      "source: { path: services/billing }",
      "source: { repo: github.com/acme/billing }",
    );
    expect(
      (await world({ ...FILES, "docs/metator/system.yml": remote }).lint.execute())._unsafeUnwrap().unchecked,
    ).toEqual(["billing-api: openapi.yaml in github.com/acme/billing"]);
  });

  test("a missing directory or specification is an error", async () => {
    const { "services/billing/openapi.yaml": _spec, ...rest } = FILES;
    const noSpec = (await world(rest).lint.execute())._unsafeUnwrap().problems.map((p) => p.message);
    expect(noSpec).toEqual([
      '"billing": directory services/billing does not exist',
      'contract "billing-api": specification services/billing/openapi.yaml does not exist',
    ]);
  });

  test("an application at the repository root needs no directory check", async () => {
    const root = MAP.replace("source: { path: services/billing }", "source: { path: . }");
    const r = (
      await world({
        ...FILES,
        "docs/metator/system.yml": root,
        "openapi.yaml": "openapi: 3.1.0",
      }).lint.execute()
    )._unsafeUnwrap();
    expect(r.problems).toEqual([]);
  });

  test("no map: nothing to check; show says where the map is expected; an invalid map is an error value", async () => {
    expect((await world({}).lint.execute())._unsafeUnwrap()).toEqual({
      source: "docs/metator/system.yml",
      mapped: false,
      problems: [],
      unchecked: [],
    });
    expect((await world({}).show.execute())._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    const broken = world({ "docs/metator/system.yml": "kind: SystemMap\nschemaVersion: 1\nsystem: Bad\n" });
    expect((await broken.lint.execute())._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
    expect((await broken.show.execute())._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
  });

  test("show: applications, each contract's users and the deploy waves", async () => {
    const r = (await world().show.execute())._unsafeUnwrap();
    expect([r.system, r.applications.map((a) => a.id), r.contracts, r.deployWaves]).toEqual([
      "billing-platform",
      ["web", "billing", "notifications"],
      [{ contract: "billing-api", kind: "openapi", owner: "billing", consumers: ["notifications", "web"] }],
      [["billing"], ["notifications", "web"]],
    ]);
    const none = MAP.replace("contracts:", "policies: { deployOrder: none }\ncontracts:");
    expect(
      (await world({ ...FILES, "docs/metator/system.yml": none }).show.execute())._unsafeUnwrap().deployWaves,
    ).toBeUndefined();
  });
});
