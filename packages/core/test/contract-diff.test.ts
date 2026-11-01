import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { DiffContracts } from "../src/application/contract-diff.ts";
import { SystemCatalog } from "../src/application/system.ts";
import { CloneCache, LocalSystemLocation, SystemSources } from "../src/application/system-sources.ts";
import { type ContractChange, inRange, judgeContract, statusOf } from "../src/domain/contract-diff.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import { SystemMapSchema } from "../src/domain/system-map.ts";
import type { ContractDiffer } from "../src/ports/index.ts";

const change = (severity: ContractChange["severity"]): ContractChange => ({
  code: "x",
  severity,
  location: "paths./a",
  message: "m",
});
const contract = (compatibility: "backward" | "none" = "backward") =>
  SystemMapSchema.parse({
    system: "s",
    applications: [{ id: "b", source: { path: "." } }],
    contracts: [{ id: "api", kind: "openapi", owner: "b", spec: { path: "o.yaml" }, compatibility }],
  }).contracts[0] as never;
const policies = (breaking: "expand-contract" | "versioned" | "forbidden") =>
  ({ deployOrder: "providers-first", breaking }) as const;

describe("contract diff domain", () => {
  test("the status the changes add up to", () => {
    const both = { before: true, after: true };
    expect(statusOf([], both)).toBe("unchanged");
    expect(statusOf([change("non-breaking")], both)).toBe("compatible");
    expect(statusOf([change("non-breaking"), change("unclassified")], both)).toBe("unclassified");
    expect(statusOf([change("unclassified"), change("breaking")], both)).toBe("breaking");
    expect(statusOf([], { before: false, after: true })).toBe("added");
    expect(statusOf([], { before: true, after: false })).toBe("removed");
    expect(statusOf([], { before: false, after: false })).toBe("unchanged");
  });

  test("version ranges: coerced versions, unknown without a valid range", () => {
    expect(inRange("1.4.0", "^1")).toBe(true);
    expect(inRange("v2", "^1")).toBe(false);
    expect(inRange("2.0.0", undefined)).toBeUndefined();
    expect(inRange("2.0.0", "not a range")).toBeUndefined();
    expect(inRange("draft", "^1")).toBeUndefined();
  });

  test("breaking changes: forbidden, expand-contract, versioned with and without a major bump, none", () => {
    const consumers = [{ app: "web", range: "^1" }, { app: "mail" }];
    const judge = (
      breaking: "expand-contract" | "versioned" | "forbidden",
      versions: { before?: string; after?: string },
      status: "breaking" | "removed" = "breaking",
      compatibility: "backward" | "none" = "backward",
    ) =>
      judgeContract({
        contract: contract(compatibility),
        policies: policies(breaking),
        status,
        versions,
        consumers,
      });
    const v2 = { before: "1.4.0", after: "2.0.0" };
    expect(judge("forbidden", v2).allowed).toBe(false);
    expect(judge("forbidden", v2).reason).toBe(
      "breaking changes are forbidden (consumed by web, mail). Consumers outside the new version's range: web.",
    );
    expect(judge("expand-contract", v2).reason).toStartWith(
      "a breaking change (consumed by web, mail): expand first",
    );
    expect(judge("versioned", v2)).toEqual({
      status: "breaking",
      allowed: true,
      reason: "a new major version 2.0.0. Consumers outside the new version's range: web.",
      consumers: [{ app: "web", range: "^1", satisfied: false }, { app: "mail" }],
    });
    expect(judge("versioned", { before: "1.4.0", after: "1.5.0" }).allowed).toBe(false);
    expect(judge("versioned", { after: "2.0.0" }).allowed).toBe(false);
    expect(judge("versioned", v2, "removed").allowed).toBe(false);
    expect(judge("forbidden", v2, "breaking", "none")).toMatchObject({ allowed: true });
  });

  test("compatible and unclassified changes pass; consumers outside the range are still named", () => {
    const compatible = judgeContract({
      contract: contract(),
      policies: policies("forbidden"),
      status: "compatible",
      versions: { before: "1.0.0", after: "1.1.0" },
      consumers: [{ app: "web", range: "^1" }],
    });
    expect(compatible).toEqual({
      status: "compatible",
      allowed: true,
      consumers: [{ app: "web", range: "^1", satisfied: true }],
    });
    const out = judgeContract({
      contract: contract(),
      policies: policies("forbidden"),
      status: "compatible",
      versions: { after: "3.0.0" },
      consumers: [{ app: "web", range: "^1" }],
    });
    expect([out.allowed, out.reason]).toEqual([true, "Consumers outside the new version's range: web."]);
    const unknown = judgeContract({
      contract: contract(),
      policies: policies("forbidden"),
      status: "unclassified",
      versions: {},
      consumers: [],
    });
    expect([unknown.allowed, unknown.reason]).toEqual([
      true,
      "some changes could not be classified: review them by hand",
    ]);
  });
});

const MAP = `kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - id: billing
    source: { path: apps/billing }
  - id: web
    source: { repo: ../web }
    consumes: [billing-api@^1, prices]
  - id: pricing
    source: { repo: ../pricing }
contracts:
  - { id: billing-api, kind: openapi, owner: billing, spec: { path: openapi.yaml } }
  - { id: events, kind: asyncapi, owner: billing, spec: { path: events.yaml } }
  - { id: prices, kind: openapi, owner: pricing, spec: { path: p.yaml } }
`;

class FakeDiffer implements ContractDiffer {
  readonly kind = "openapi";
  readonly seen: string[] = [];
  constructor(private readonly fail = false) {}
  async compare(before: { path: string; text: string }, after: { path: string; text: string }) {
    this.seen.push(`${before.path}:${before.text}->${after.text}`);
    if (this.fail) return err(new MetatorError("PARSE_FAILED", "bad spec"));
    return ok({ changes: [change("breaking")], versions: { before: "1", after: "1.1" } });
  }
}

const NOTHING_PLANNED = { allows: async () => ok(undefined) };
const sourcesOf = (location: LocalSystemLocation) =>
  new SystemSources(
    undefined,
    "/src/platform",
    location,
    new CloneCache({ resolve: async () => ok("a".repeat(40)), checkout: async () => ok(undefined) }, "/c"),
    { isDirectory: async () => false, read: async () => ok(undefined) },
    { remoteUrl: async () => ok(undefined) },
  );

function setup(files: Record<string, string>, base: Record<string, string>, differ = new FakeDiffer()) {
  const fs = new InMemoryFileSystem({ "docs/metator/system.yml": MAP, ...files });
  const location = new LocalSystemLocation(new SystemCatalog(fs, "docs/metator/system.yml"), "/src/platform");
  const revisions = {
    readAt: async (ref: string, path: string) => ok(ref === "main" ? base[path] : undefined),
  };
  return { differ, diff: new DiffContracts(sourcesOf(location), revisions, fs, [differ], NOTHING_PLANNED) };
}

describe("DiffContracts", () => {
  test("the provided contracts: compared by their kind's differ, unchanged, added and removed", async () => {
    const { diff, differ } = setup(
      { "apps/billing/openapi.yaml": "v2" },
      { "apps/billing/openapi.yaml": "v1", "apps/billing/events.yaml": "e1" },
    );
    const r = (await diff.execute({ base: "main" }))._unsafeUnwrap();
    expect(differ.seen).toEqual(["apps/billing/openapi.yaml:v1->v2"]);
    expect(r.contracts.map((c) => [c.id, c.spec, c.status, c.allowed])).toEqual([
      ["billing-api", "apps/billing/openapi.yaml", "breaking", false],
      ["events", "apps/billing/events.yaml", "removed", false],
    ]);
    expect(r.failing).toEqual(["billing-api", "events"]);
    expect(r.contracts[0]?.consumers).toEqual([{ app: "web", range: "^1", satisfied: true }]);
    const added = setup({ "apps/billing/openapi.yaml": "v1" }, {});
    expect(
      (await added.diff.execute({ base: "main" }))._unsafeUnwrap().contracts.map((c) => c.status),
    ).toEqual(["added", "unchanged"]);
    const same = setup({ "apps/billing/openapi.yaml": "v1" }, { "apps/billing/openapi.yaml": "v1" });
    expect((await same.diff.execute({ base: "main" }))._unsafeUnwrap().contracts[0]?.status).toBe(
      "unchanged",
    );
    expect(same.differ.seen).toEqual([]);
  });

  test("a contract served at runtime (SystemMap v2) is listed as not compared, never as unchanged", async () => {
    const served = MAP.replace("schemaVersion: 1", "schemaVersion: 2").replace(
      "{ id: events, kind: asyncapi, owner: billing, spec: { path: events.yaml } }",
      "{ id: events, kind: openapi, owner: billing, spec: { served: /docs-json } }",
    );
    const { diff } = setup(
      { "docs/metator/system.yml": served, "apps/billing/openapi.yaml": "v1" },
      { "apps/billing/openapi.yaml": "v1" },
    );
    const r = (await diff.execute({ base: "main" }))._unsafeUnwrap();
    expect(r.contracts.map((c) => c.id)).toEqual(["billing-api"]);
    expect(r.notCompared).toEqual([{ id: "events", served: "/docs-json" }]);
  });

  test("a breaking change an approved system plan covers passes, with the plan's reason", async () => {
    const fs = new InMemoryFileSystem({
      "docs/metator/system.yml": MAP,
      "apps/billing/openapi.yaml": "v2",
    });
    const location = new LocalSystemLocation(
      new SystemCatalog(fs, "docs/metator/system.yml"),
      "/src/platform",
    );
    const asked: string[] = [];
    const planned = {
      allows: async (id: string, owner: string) => {
        asked.push(`${id} of ${owner}`);
        return ok(id === "billing-api" ? "planned in system plan p" : undefined);
      },
    };
    const diff = new DiffContracts(
      sourcesOf(location),
      {
        readAt: async (_: string, path: string) =>
          ok(path === "apps/billing/openapi.yaml" ? "v1" : undefined),
      },
      fs,
      [new FakeDiffer()],
      planned,
    );
    const r = (await diff.execute({ base: "main" }))._unsafeUnwrap();
    expect(r.contracts.map((c) => [c.id, c.allowed])).toEqual([
      ["billing-api", true],
      ["events", true],
    ]);
    expect(r.contracts[0]?.reason).toStartWith("planned in system plan p; a breaking change");
    expect(asked).toEqual(["billing-api of billing"]); // only what the policy refuses is asked about
  });

  test("a kind without a differ is unclassified, not a failure", async () => {
    const { diff } = setup({ "apps/billing/events.yaml": "e2" }, { "apps/billing/events.yaml": "e1" });
    const r = (await diff.execute({ base: "main", contracts: ["events"] }))._unsafeUnwrap();
    expect(r.contracts.map((c) => [c.status, c.allowed, c.changes[0]?.code])).toEqual([
      ["unclassified", true, "kind.unsupported"],
    ]);
  });

  test("named contracts must exist and be provided here; differ errors are errors; no map is NOT_FOUND", async () => {
    const { diff } = setup({}, {});
    expect((await diff.execute({ base: "main", contracts: ["nope"] }))._unsafeUnwrapErr().message).toBe(
      "unknown contract nope",
    );
    expect((await diff.execute({ base: "main", contracts: ["prices"] }))._unsafeUnwrapErr().message).toBe(
      "prices is provided by pricing, not by this repository",
    );
    const broken = setup(
      { "apps/billing/openapi.yaml": "v2" },
      { "apps/billing/openapi.yaml": "v1" },
      new FakeDiffer(true),
    );
    expect((await broken.diff.execute({ base: "main" }))._unsafeUnwrapErr().message).toBe("bad spec");
    const empty = new DiffContracts(
      sourcesOf(new LocalSystemLocation(new SystemCatalog(new InMemoryFileSystem(), "x.yml"), "/r")),
      { readAt: async () => ok(undefined) },
      new InMemoryFileSystem(),
      [],
      NOTHING_PLANNED,
    );
    expect((await empty.execute({ base: "main" }))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});
