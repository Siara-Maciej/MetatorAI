/**
 * `metator system analyze` and `system plan` end to end (F7.5): a real monorepo whose billing
 * service provides an OpenAPI contract that web and mail consume. A breaking rename is analyzed,
 * drafted as expand → migrate → contract, linted (a missing migration fails), approved by a
 * person, and then lets `contract diff --check` pass the breaking change only once the consumers'
 * steps are done.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";
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
const MAP = `kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - { id: billing, kind: service, source: { path: apps/billing }, owners: ["@billing-team"] }
  - { id: web, kind: frontend, source: { path: apps/web }, owners: ["@web-team"], consumes: [billing-api@^1] }
  - { id: mail, kind: worker, source: { path: apps/mail }, owners: ["@mail-team"], consumes: [billing-api] }
contracts:
  - { id: billing-api, kind: openapi, owner: billing, spec: { path: openapi.yaml } }
`;
const PLAN = "metator/system/plans/rename-refunds.yml";

interface Step {
  id: string;
  app: string;
  dependsOn: string[];
  status: string;
  contracts: { id: string; role: string }[];
}

let repo: ScratchRepo;
let env: Record<string, string>;
const mt = (...args: string[]) => metator(args, repo.root, env);
const editPlan = async (change: (plan: { steps: Step[] } & Record<string, unknown>) => void) => {
  const plan = parse(await repo.read(PLAN));
  change(plan);
  await repo.write(PLAN, stringify(plan));
};

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nscenario.yml\n");
  // The system agents on the scenario host: the scout checks the analysis, the planner the draft.
  await repo.write(
    "scenario.yml",
    'kind: AgentScenario\nschemaVersion: 1\nagents:\n  mt-system-scout:\n    - - say: "billing-api only gains a path."\n  mt-system-planner:\n    - - say: "One step in billing."\n',
  );
  await repo.write("docs/metator/system.yml", MAP);
  await repo.write("apps/billing/openapi.yaml", SPEC);
  await repo.write("apps/web/src/main.ts", "export const m = 1;\n");
  await repo.write("apps/mail/src/main.ts", "export const m = 1;\n");
  await repo.commit("init");
  await repo.git("checkout", "-q", "-b", "rename");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml"), METATOR_USER: "ana", METATOR_HOST: "scenario" };
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator system plan (real CLI, real monorepo)", () => {
  test("analyze: a contract marked breaking, its consumers and owners, saved for the plan", async () => {
    const run = await mt("system", "analyze", "Rename", "refunds", "--breaking", "billing-api");
    expect(run.code).toBe(0);
    const data = run.json.data as {
      id: string;
      file: string;
      analysis: {
        contracts: { id: string; change: string; consumers: { app: string }[] }[];
        applications: { id: string; roles: string[] }[];
      };
    };
    expect([data.id, data.file]).toEqual([
      "rename-refunds",
      "metator/system/plans/rename-refunds.analysis.yml",
    ]);
    expect(data.analysis.contracts.map((c) => [c.id, c.change, c.consumers.map((k) => k.app)])).toEqual([
      ["billing-api", "breaking", ["web", "mail"]],
    ]);
    expect(data.analysis.applications.map((a) => [a.id, a.roles])).toEqual([
      ["billing", ["provider"]],
      ["web", ["consumer"]],
      ["mail", ["consumer"]],
    ]);
    expect(await repo.read(data.file)).toStartWith("# What a task touches");
  }, 60_000);

  test("new drafts expand → migrate → contract; lint fails without a consumer's migration", async () => {
    const created = await mt("system", "plan", "new", "Rename", "refunds");
    expect(created.code).toBe(0);
    const steps = (created.json.data as { steps: Step[] }).steps;
    expect(steps.map((s) => [s.id, s.dependsOn])).toEqual([
      ["billing-expand", []],
      ["web-migrate", ["billing-expand"]],
      ["mail-migrate", ["billing-expand"]],
      ["billing-contract", ["web-migrate", "mail-migrate"]],
    ]);
    const lint = await mt("system", "plan", "lint", "rename-refunds");
    expect([lint.code, (lint.json.data as { waves: string[][] }).waves]).toEqual([
      0,
      [["billing-expand"], ["web-migrate", "mail-migrate"], ["billing-contract"]],
    ]);
    const original = await repo.read(PLAN);
    await editPlan((plan) => {
      plan.steps = plan.steps
        .filter((s) => s.id !== "mail-migrate")
        .map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== "mail-migrate") }));
    });
    const bad = await mt("system", "plan", "lint", "rename-refunds");
    expect([bad.code, (bad.json.error as { code: string }).code]).toEqual([1, "CHECK_FAILED"]);
    const problems = (bad.json.error as { details: { problems: { message: string }[] } }).details.problems;
    expect(problems.map((p) => p.message)).toEqual([
      "consumer mail of billing-api has no step that migrates it",
    ]);
    const refused = await mt("system", "plan", "approve", "rename-refunds", "--by", "ana");
    expect((refused.json.error as { code: string }).code).toBe("CHECK_FAILED");
    await repo.write(PLAN, original);
  }, 90_000);

  test("approved, the breaking change passes contract diff only once the consumers have migrated", async () => {
    const approved = await mt("system", "plan", "approve", "rename-refunds", "--by", "ana");
    expect((approved.json.data as { status: string; approval: { by: string } }).approval.by).toBe("ana");
    await repo.write(
      "apps/billing/openapi.yaml",
      SPEC.replace('  /refunds:\n    post:\n      responses: { "201": { description: created } }\n', ""),
    );
    const early = await mt("contract", "diff", "--base", "main", "--check");
    expect([early.code, (early.json.error as { code: string }).code]).toEqual([1, "CHECK_FAILED"]);
    await editPlan((plan) => {
      for (const s of plan.steps) if (s.id !== "billing-contract") s.status = "done";
    });
    const now = await mt("contract", "diff", "--base", "main", "--check");
    expect(now.code).toBe(0);
    const entry = (now.json.data as { contracts: { status: string; allowed: boolean; reason: string }[] })
      .contracts[0];
    expect([entry?.status, entry?.allowed]).toEqual(["breaking", true]);
    expect(entry?.reason).toStartWith(
      "planned in system plan rename-refunds (step billing-contract, approved by ana)",
    );
    const list = (await mt("system", "plan", "list")).json.data as {
      plans: { id: string; task: string; status: string; steps: number; done: number }[];
    };
    expect(list.plans).toEqual([
      { id: "rename-refunds", task: "Rename refunds", status: "approved", steps: 4, done: 3 },
    ]);
    const show = (await mt("system", "plan", "show", "rename-refunds")).json.data as {
      waves: string[][];
      analysis: { task: string };
    };
    expect([show.waves.length, show.analysis.task]).toEqual([3, "Rename refunds"]);
    const schema = (await mt("system", "plan", "schema", "--analysis")).json.data as { properties: object };
    expect(Object.keys(schema.properties)).toContain("contracts");
  }, 120_000);

  test("propose: the scout and the planner run on the host, then the tool lints the plan", async () => {
    const run = await mt("system", "plan", "propose", "Add", "credits", "--contracts", "billing-api");
    expect(run.code).toBe(0);
    const { plan, problems } = run.json.data as {
      plan: { id: string; createdBy: string; steps: Step[] };
      problems: unknown[];
    };
    expect([plan.id, plan.createdBy, problems]).toEqual(["add-credits", "ana", []]);
    // The working tree still lacks /refunds: contract diff makes the change breaking.
    expect(plan.steps.map((s) => s.id)).toEqual([
      "billing-expand",
      "web-migrate",
      "mail-migrate",
      "billing-contract",
    ]);
    expect(await repo.read("metator/system/plans/add-credits.analysis.yml")).toContain(
      'why: "contract diff: breaking"',
    );
  }, 90_000);
});
