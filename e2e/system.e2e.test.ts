/** `system show|lint|schema` end to end: real `metator` processes on a real git repository. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const MAP = `kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - id: web
    kind: frontend
    source: { path: apps/web }
    consumes: [orders-api@^1]
  - id: orders
    source: { path: services/orders }
    owners: ["@shop/orders"]
  - id: mailer
    source: { repo: github.com/shop/mailer }
    consumes: [orders-api]
contracts:
  - id: orders-api
    kind: openapi
    owner: orders
    spec: { path: openapi.yaml }
`;

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("docs/metator/system.yml", MAP);
  await repo.write("apps/web/src/main.ts", "export {};\n");
  await repo.write(
    "services/orders/openapi.yaml",
    "openapi: 3.1.0\ninfo: { title: Orders, version: 1.0.0 }\npaths: {}\n",
  );
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator system (real CLI)", () => {
  test("show: consumers per contract and deploy waves (providers first)", async () => {
    const r = await metator(["system", "show"], repo.root);
    const data = r.json.data as { contracts: unknown[]; deployWaves: string[][] };
    expect([r.code, data.contracts, data.deployWaves]).toEqual([
      0,
      [{ contract: "orders-api", kind: "openapi", owner: "orders", consumers: ["mailer", "web"] }],
      [["orders"], ["mailer", "web"]],
    ]);
  });

  test("lint: a valid map passes and lists specifications in other repositories as unchecked", async () => {
    const r = await metator(["system", "lint"], repo.root);
    expect([r.code, (r.json.data as { unchecked: string[] }).unchecked]).toEqual([0, []]);
  });

  test("lint: a missing specification and a contract kind without a plugin fail", async () => {
    await repo.write(
      "docs/metator/system.yml",
      `${MAP.replace("spec: { path: openapi.yaml }", "spec: { path: missing.yaml }")}  - id: order-events\n    kind: asyncapi\n    owner: orders\n    spec: { path: asyncapi.yaml }\n`,
    );
    try {
      const r = await metator(["system", "lint"], repo.root);
      expect(r.code).toBe(1);
      const messages = (
        r.json.error as { details: { problems: { message: string }[] } }
      ).details.problems.map((p) => p.message);
      expect(messages).toEqual([
        'contract "order-events": kind "asyncapi" has no plugin (supported: openapi)',
        'contract "orders-api": specification services/orders/missing.yaml does not exist',
        'contract "order-events": specification services/orders/asyncapi.yaml does not exist',
      ]);
    } finally {
      await repo.write("docs/metator/system.yml", MAP);
    }
  });

  test("schema prints the SystemMap JSON Schema; check-all runs system lint", async () => {
    const schema = await metator(["system", "schema"], repo.root);
    expect((schema.json.data as { properties: { kind: { const: string } } }).properties.kind.const).toBe(
      "SystemMap",
    );
    const all = await metator(["meta", "check-all"], repo.root);
    const checks = (all.json.error as { details: { checks: { command: string; passed: boolean }[] } }).details
      .checks;
    expect(checks.find((c) => c.command === "system lint")?.passed).toBe(true);
  }, 60_000);

  test("no map: lint has nothing to check, show names the expected file", async () => {
    const empty = await ScratchRepo.create();
    try {
      expect((await metator(["system", "lint"], empty.root)).json.data).toMatchObject({ mapped: false });
      const show = await metator(["system", "show"], empty.root);
      expect([show.code, (show.json.error as { message: string }).message]).toEqual([
        1,
        "No system map at docs/metator/system.yml",
      ]);
    } finally {
      await empty.dispose();
    }
  });
});
