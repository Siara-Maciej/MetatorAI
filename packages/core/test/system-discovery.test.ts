import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { DiscoverSystem, type DiscoverySource } from "../src/application/system-discovery.ts";
import { ok } from "../src/domain/result.ts";
import {
  contractIds,
  type FoundContract,
  kindFrom,
  needlesOf,
  proposeSystem,
  slugId,
  systemDrift,
} from "../src/domain/system-discovery.ts";
import { SystemMapSchema } from "../src/domain/system-map.ts";
import type { ContractDetector } from "../src/ports/index.ts";

const contract = (over: Partial<FoundContract> = {}): FoundContract => ({
  app: "billing",
  kind: "openapi",
  spec: "openapi.yaml",
  title: "Billing API",
  servers: [],
  ...over,
});

describe("discovery helpers", () => {
  test("ids: scope dropped, words dashed, a leading digit prefixed", () => {
    expect([slugId("@shop/web"), slugId("Billing API v2"), slugId("3d-viewer"), slugId("!!!")]).toEqual([
      "web",
      "billing-api-v2",
      "x-3d-viewer",
      "app",
    ]);
  });

  test("kinds from names and dependencies; a command-line tool is not a frontend", () => {
    expect(kindFrom("@shop/notify-worker", [], false)).toBe("worker");
    expect(kindFrom("edge-gateway", [], false)).toBe("gateway");
    expect(kindFrom("api", ["hono"], false)).toBe("service");
    expect(kindFrom("api", [], true)).toBe("service");
    expect(kindFrom("web", ["react"], false)).toBe("frontend");
    expect(kindFrom("cli", ["react", "ink"], false, true)).toBe("other");
    expect(kindFrom("misc", [], false)).toBe("other");
  });

  test("contract ids are unique; a title-less spec is named after its file", () => {
    const a = contract();
    const b = contract({ app: "legacy" });
    const c = contract({ title: "specs/orders.yaml", spec: "specs/orders.yaml" });
    expect([...contractIds([a, b, c]).values()]).toEqual(["billing-api", "billing-api-2", "specs-orders"]);
  });

  test("needles: the spec path from the provider's directory; specific server hosts only", () => {
    expect(
      needlesOf(
        contract({
          servers: [
            "https://billing.shop.internal/v2",
            "http://billing",
            "http://localhost:8080",
            "http://api:8080/x",
          ],
        }),
        "apps/billing",
      ).map((n) => [n.text, n.confidence]),
    ).toEqual([
      ["billing/openapi.yaml", "medium"],
      ["billing.shop.internal", "low"],
      ["api:8080", "low"],
    ]);
    expect(needlesOf(contract(), ".")).toEqual([]);
  });

  test("proposal: applications, contracts, consumes from medium or high evidence only", () => {
    const c = contract();
    const d = proposeSystem({
      system: "shop",
      topology: "monorepo",
      apps: [
        {
          id: "billing",
          source: { path: "apps/billing" },
          kind: "service",
          owners: ["@b"],
          deployUnit: "billing",
          signals: ["Dockerfile"],
        },
        { id: "web", source: { path: "apps/web" }, kind: "frontend", owners: [], signals: ["app"] },
        { id: "worker", source: { path: "apps/worker" }, kind: "worker", owners: [], signals: ["app"] },
      ],
      contracts: [c],
      references: [
        {
          from: "web",
          contract: "billing-api",
          file: "apps/web/package.json",
          reason: "r",
          confidence: "medium",
        },
        {
          from: "worker",
          contract: "billing-api",
          file: "apps/worker/x.ts",
          reason: "url",
          confidence: "low",
        },
      ],
      ids: new Map([[c, "billing-api"]]),
    });
    expect(d.proposal.applications.map((a) => [a.id, a.consumes, a.deploy])).toEqual([
      ["billing", [], { unit: "billing", environments: [] }],
      ["web", ["billing-api"], undefined],
      ["worker", [], undefined],
    ]);
    expect(SystemMapSchema.parse(d.proposal).contracts[0]?.id).toBe("billing-api");
    expect(d.evidence.filter((e) => !e.proposed).map((e) => e.subject)).toEqual([
      "consumes:worker→billing-api",
    ]);
  });

  test("drift: what the code shows and the map lacks", () => {
    const map = SystemMapSchema.parse({
      system: "s",
      applications: [
        { id: "billing", source: { path: "a" } },
        { id: "web", source: { path: "w" }, consumes: [] },
      ],
      contracts: [{ id: "billing", kind: "openapi", owner: "billing", spec: { path: "openapi.yaml" } }],
    });
    const proposal = SystemMapSchema.parse({
      system: "s",
      applications: [
        { id: "billing", source: { path: "a" } },
        { id: "web", source: { path: "w" }, consumes: ["billing-api"] },
        { id: "admin", source: { path: "x" } },
      ],
      contracts: [
        { id: "billing-api", kind: "openapi", owner: "billing", spec: { path: "openapi.yaml" } },
        { id: "orders", kind: "openapi", owner: "billing", spec: { path: "orders.yaml" } },
      ],
    });
    // The map names the contract billing; the proposal calls the same specification billing-api.
    expect(systemDrift(map, proposal)).toEqual([
      "web consumes billing, but the map does not say so",
      "application admin is not in the map",
      "contract orders (orders.yaml of billing) is not in the map",
    ]);
    const consumed = SystemMapSchema.parse({
      ...map,
      applications: map.applications.map((a) => (a.id === "web" ? { ...a, consumes: ["billing@^1"] } : a)),
    });
    expect(systemDrift(consumed, proposal)).toEqual([
      "application admin is not in the map",
      "contract orders (orders.yaml of billing) is not in the map",
    ]);
  });
});

function source(
  name: string,
  over: Partial<{
    apps: unknown[];
    specs: unknown[];
    texts: { path: string; text: string }[];
    remote: string;
  }> = {},
): DiscoverySource {
  return {
    name,
    remote: async () => over.remote,
    applications: async () =>
      ok(
        (over.apps ?? [
          { name, dir: ".", deps: [], signals: ["one app"], docker: false, bin: false },
        ]) as never,
      ),
    specifications: async () => ok((over.specs ?? []) as never),
    owners: async (dirs) => ok(dirs.map(() => [])),
    texts: async function* () {
      for (const t of over.texts ?? []) yield t;
    },
  };
}
const detectors: ContractDetector[] = [];
const SPEC = { path: "openapi.yaml", title: "Billing API", servers: [], kind: "openapi" };

describe("DiscoverSystem", () => {
  test("one repository with several applications is a monorepo; specs belong to the deepest application", async () => {
    const r = (
      await new DiscoverSystem(detectors).execute({
        system: "Shop",
        sources: [
          source("shop", {
            apps: [
              {
                name: "@shop/billing",
                dir: "apps/billing",
                deps: ["hono"],
                signals: ["app"],
                docker: true,
                bin: false,
              },
              {
                name: "@shop/web",
                dir: "apps/web",
                deps: ["react"],
                signals: ["app"],
                docker: false,
                bin: false,
              },
            ],
            specs: [
              { ...SPEC, path: "apps/billing/openapi.yaml" },
              { ...SPEC, path: "docs/example.yaml", title: "Example" },
            ],
            texts: [
              { path: "apps/web/package.json", text: '"gen": "x ../billing/openapi.yaml"' },
              { path: "apps/billing/src/x.ts", text: "billing/openapi.yaml" },
              { path: "scripts/x.ts", text: "billing/openapi.yaml" },
            ],
          }),
        ],
      })
    )._unsafeUnwrap();
    expect([r.topology, r.proposal.system, r.map, r.drift]).toEqual(["monorepo", "shop", null, []]);
    expect(r.proposal.contracts).toEqual([
      {
        id: "billing-api",
        kind: "openapi",
        owner: "billing",
        spec: { path: "openapi.yaml" },
        compatibility: "backward",
      },
    ]);
    expect(r.proposal.applications.map((a) => [a.id, a.consumes])).toEqual([
      ["billing", []],
      ["web", ["billing-api"]],
    ]);
  });

  test("a folder: repositories are applications by name, sources by remote, clashing ids prefixed", async () => {
    const r = (
      await new DiscoverSystem(detectors).execute({
        system: "landscape",
        sources: [
          source("billing", { remote: "git@github.com:acme/billing.git", specs: [SPEC] }),
          source("web", { texts: [{ path: "package.json", text: "../billing/openapi.yaml" }] }),
          source("tools", {
            apps: [{ name: "web", dir: "apps/web", deps: [], signals: ["s"], docker: false, bin: false }],
          }),
        ],
      })
    )._unsafeUnwrap();
    expect(r.topology).toBe("repos");
    expect(r.proposal.applications.map((a) => [a.id, a.source, a.consumes])).toEqual([
      ["billing", { repo: "git@github.com:acme/billing.git" }, []],
      ["web", { repo: "web" }, ["billing-api"]],
      ["tools-web", { repo: "tools", path: "apps/web" }, []],
    ]);
    expect(r.evidence.find((e) => e.subject === "consumes:web→billing-api")?.file).toBe("web/package.json");
  });

  test("with a map: drift, a written proposal when there is none, never an overwrite", async () => {
    const fs = new InMemoryFileSystem();
    const map = { file: "docs/metator/system.yml", load: async () => ok(undefined), fs };
    const written = (
      await new DiscoverSystem(detectors).execute({ system: "s", sources: [source("s")], map, write: true })
    )._unsafeUnwrap();
    expect(written.written).toBe("docs/metator/system.yml");
    expect((await fs.read("docs/metator/system.yml"))._unsafeUnwrap()).toContain("kind: SystemMap");
    const existing = SystemMapSchema.parse({
      system: "s",
      applications: [{ id: "other", source: { path: "." } }],
    });
    const withMap = { ...map, load: async () => ok(existing) };
    const drift = (
      await new DiscoverSystem(detectors).execute({ system: "s", sources: [source("s")], map: withMap })
    )._unsafeUnwrap();
    expect(drift.drift).toEqual(["application s is not in the map"]);
    const again = await new DiscoverSystem(detectors).execute({
      system: "s",
      sources: [source("s")],
      map: withMap,
      write: true,
    });
    expect(again._unsafeUnwrapErr().code).toBe("USAGE");
  });
});
