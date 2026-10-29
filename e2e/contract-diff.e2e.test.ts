/**
 * `metator contract diff` end to end (F7.4): a real monorepo whose billing service provides an
 * OpenAPI contract that web consumes at `^1`. Added paths are compatible; a removed path breaks
 * the contract and fails `--check` and the gate under expand-contract; under the versioned policy
 * a new major version is allowed, and web is named as outside the new version's range.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SPEC = `openapi: 3.0.3
info: { title: Billing API, version: 1.4.0 }
paths:
  /invoices:
    get:
      responses: { "200": { description: ok } }
  /refunds:
    post:
      responses: { "201": { description: created } }
`;
const MAP = (breaking: string) => `kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - id: billing
    kind: service
    source: { path: apps/billing }
    owners: ["@billing-team"]
  - id: web
    kind: frontend
    source: { path: apps/web }
    consumes: [billing-api@^1]
contracts:
  - id: billing-api
    kind: openapi
    owner: billing
    spec: { path: openapi.yaml }
policies: { breaking: ${breaking} }
`;
const CONFIG = `kind: MetatorConfig
schemaVersion: 4
gates:
  full:
    - id: contracts
      run: { metator: contract diff }
`;

interface Entry {
  id: string;
  status: string;
  allowed: boolean;
  reason?: string;
  versions: { before?: string; after?: string };
  changes: { code: string; severity: string }[];
  consumers: { app: string; range?: string; satisfied?: boolean }[];
}
type Report = { base: string; contracts: Entry[]; failing: string[] };

let repo: ScratchRepo;
const mt = (...args: string[]) => metator(args, repo.root);

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write("metator.config.yml", CONFIG);
  await repo.write("docs/metator/system.yml", MAP("expand-contract"));
  await repo.write("apps/billing/openapi.yaml", SPEC);
  await repo.write("apps/billing/src/server.ts", "export const s = 1;\n");
  await repo.write("apps/web/src/main.ts", "export const m = 1;\n");
  await repo.commit("init");
  await repo.git("checkout", "-q", "-b", "feature");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator contract diff (real CLI, real monorepo)", () => {
  test("unchanged, then an added path is compatible", async () => {
    const same = (await mt("contract", "diff", "--base", "main")).json.data as Report;
    expect(same.contracts.map((c) => [c.id, c.status, c.allowed])).toEqual([
      ["billing-api", "unchanged", true],
    ]);
    await repo.write(
      "apps/billing/openapi.yaml",
      SPEC.replace(
        "paths:\n",
        'paths:\n  /credits:\n    get:\n      responses: { "200": { description: ok } }\n',
      ),
    );
    const added = (await mt("contract", "diff", "--base", "main")).json.data as Report;
    expect(added.contracts[0]?.status).toBe("compatible");
    expect(added.contracts[0]?.changes).toEqual([
      expect.objectContaining({
        code: "operation.add",
        severity: "non-breaking",
        location: "paths./credits.get",
      }),
    ]);
    expect((await mt("gate", "full", "--base", "main")).code).toBe(0);
  }, 90_000);

  test("a removed path breaks the contract: --check and the gate fail under expand-contract", async () => {
    await repo.write(
      "apps/billing/openapi.yaml",
      SPEC.replace('  /refunds:\n    post:\n      responses: { "201": { description: created } }\n', ""),
    );
    const report = await mt("contract", "diff", "--base", "main");
    expect(report.code).toBe(0);
    const entry = (report.json.data as Report).contracts[0] as Entry;
    expect([entry.status, entry.allowed]).toEqual(["breaking", false]);
    expect(entry.reason).toContain("expand first");
    expect(report.json.warnings).toEqual([`billing-api: ${entry.reason}`]);
    const check = await mt("contract", "diff", "--base", "main", "--check");
    expect([check.code, (check.json.error as { code: string }).code]).toEqual([1, "CHECK_FAILED"]);
    const gate = await mt("gate", "full", "--base", "main");
    expect(gate.code).toBe(1);
    const steps = (
      gate.json.error as { details: { steps: { id: string; status: string; detail?: string }[] } }
    ).details.steps;
    expect(steps.map((s) => `${s.id}:${s.status}`)).toEqual(["contracts:fail"]);
    expect(steps[0]?.detail).toStartWith("billing-api (breaking): a breaking change (consumed by web)");
  }, 90_000);

  test("under the versioned policy a new major version is allowed and web is outside its range", async () => {
    await repo.write("docs/metator/system.yml", MAP("versioned"));
    const unbumped = (await mt("contract", "diff", "--base", "main")).json.data as Report;
    expect(unbumped.failing).toEqual(["billing-api"]);
    await repo.write(
      "apps/billing/openapi.yaml",
      SPEC.replace(
        '  /refunds:\n    post:\n      responses: { "201": { description: created } }\n',
        "",
      ).replace("1.4.0", "2.0.0"),
    );
    const run = await mt("contract", "diff", "--base", "main", "--check");
    expect(run.code).toBe(0);
    const entry = (run.json.data as Report).contracts[0] as Entry;
    expect([entry.status, entry.allowed, entry.versions]).toEqual([
      "breaking",
      true,
      { before: "1.4.0", after: "2.0.0" },
    ]);
    expect(entry.consumers).toEqual([{ app: "web", range: "^1", satisfied: false }]);
    expect(run.json.warnings).toEqual([
      "billing-api: a new major version 2.0.0. Consumers outside the new version's range: web.",
    ]);
    const unknown = await mt("contract", "diff", "--contracts", "nope");
    expect((unknown.json.error as { message: string }).message).toBe("unknown contract nope");
  }, 90_000);

  test("a query parameter that becomes required is breaking (OpenAPI 3.1 too)", async () => {
    await repo.write("docs/metator/system.yml", MAP("expand-contract"));
    const withParam = (required: boolean) =>
      SPEC.replace("openapi: 3.0.3", "openapi: 3.1.0").replace(
        "    get:\n",
        `    get:\n      parameters: [{ name: status, in: query, required: ${required}, schema: { type: string } }]\n`,
      );
    await repo.write("apps/billing/openapi.yaml", withParam(false));
    await repo.commit("a parameter");
    await repo.write("apps/billing/openapi.yaml", withParam(true));
    const r = (await mt("contract", "diff")).json.data as Report;
    const entry = r.contracts[0] as Entry;
    expect([entry.status, entry.allowed, entry.changes.map((c) => [c.code, c.severity])]).toEqual([
      "breaking",
      false,
      [["parameter.add", "breaking"]],
    ]);
  }, 90_000);
});
