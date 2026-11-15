/**
 * A person edits plans in the app (ADR-0087), end to end on a real daemon over a real repository:
 * the run's plan (read, lint, save, a stale digest, an invalid plan, read-only past its gate), the
 * run's files (listed, read, nothing out of the run directory), system plans (list, edit, approve,
 * back to draft) and the system map (read, save, a stale digest, proposed from the code).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.json, plan-scope.json]
  - id: plan-approval
    hitl: true
  - id: build
    owner: mt-implementer
    produces: [build-log.md]
`;
const PLAN = {
  task: "Add the discount",
  scope: ["src/**"],
  steps: [
    { id: "S1", action: "create", path: "src/invoice.test.ts", intent: "tests first" },
    {
      id: "S2",
      action: "modify",
      path: "src/invoice.ts",
      intent: "discount()",
      testsFirst: ["src/invoice.test.ts"],
      dependsOn: ["S1"],
    },
  ],
};
const MAP = `kind: SystemMap
schemaVersion: 2
system: shop
applications:
  - { id: api, source: { path: "." } }
`;
const SYSTEM_PLAN = `kind: SystemPlan
schemaVersion: 1
id: add-a-flag
task: Add a flag
steps:
  - { id: api-change, app: api, summary: Add the flag }
`;
const ANALYSIS = `kind: SystemAnalysis
schemaVersion: 1
task: Add a flag
map: docs/metator/system.yml
applications:
  - { id: api, roles: [changed] }
`;

let repo: ScratchRepo;
let runId = "";
let base = "";
let daemon: ReturnType<typeof Bun.spawn> | undefined;
type Envelope = {
  ok: boolean;
  data: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
};

async function http(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Envelope }> {
  const r = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  return { status: r.status, json: (await r.json()) as Envelope };
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("src/invoice.ts", "export const total = (n: number) => n;\n");
  await repo.write("docs/metator/system.yml", MAP);
  await repo.write("metator/system/plans/add-a-flag.yml", SYSTEM_PLAN);
  await repo.write("metator/system/plans/add-a-flag.analysis.yml", ANALYSIS);
  await repo.commit("init");
  const started = await metator(
    ["run", "init", "--workflow", "demo", "--task", "Add the discount"],
    repo.root,
  );
  runId = (started.json.data as { runId: string }).runId;
  const dir = `.metator/runs/${runId}`;
  await repo.write(`${dir}/plan.json`, JSON.stringify({ kind: "Plan", schemaVersion: 1, ...PLAN }, null, 2));
  await repo.write(`${dir}/plan.md`, "# The plan\n\nTests first.\n");
  await symlink("/etc/hostname", join(repo.root, dir, "leak.md")).catch(() => undefined);
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: repo.root,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = (daemon.stderr as ReadableStream<Uint8Array>).getReader();
  let text = "";
  const deadline = Date.now() + 20_000;
  while (!base && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.includes('"serving"'));
    if (line) base = (JSON.parse(line) as { serving: { url: string } }).serving.url;
  }
}, 60_000);

afterAll(async () => {
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  await repo.dispose();
});

describe("the run's plan from the daemon", () => {
  test("read, lint, save with who and what in the activity; a stale digest is 409; an invalid plan 400; nothing written", async () => {
    const view = await http("GET", `/runs/${runId}/plan`);
    expect(view.status).toBe(200);
    expect([view.json.data.editable, view.json.data.stage, view.json.data.approvalStage]).toEqual([
      true,
      "plan",
      "plan-approval",
    ]);
    const digest = view.json.data.digest as string;

    const lint = await http("POST", `/runs/${runId}/plan/lint`, { plan: { ...PLAN, scope: [] } });
    expect((lint.json.data.problems as { field?: string }[])[0]?.field).toBe("scope");

    const edited = {
      ...PLAN,
      steps: [...PLAN.steps, { id: "S3", action: "modify", path: "src/invoice.ts", intent: "round" }],
    };
    const saved = await http("PUT", `/runs/${runId}/plan`, { plan: edited, digest, by: "ana" });
    expect(saved.status).toBe(200);
    expect(saved.json.data.digest).not.toBe(digest);
    const activity = (await metator(["run", "activity", "--run", runId], repo.root)).json.data as {
      entries: { type: string; text: string }[];
    };
    expect(activity.entries.at(-1)).toMatchObject({
      type: "plan-edited",
      text: "plan edited by ana: step added: S3",
    });

    const stale = await http("PUT", `/runs/${runId}/plan`, { plan: PLAN, digest, by: "bob" });
    expect([stale.status, stale.json.error?.code]).toEqual([409, "CONFLICT"]);
    expect(
      (stale.json.error as unknown as { details: { current: { digest: string } } }).details.current.digest,
    ).toBe(saved.json.data.digest as string);

    const invalid = await http("PUT", `/runs/${runId}/plan`, {
      plan: { ...PLAN, steps: [] },
      digest: saved.json.data.digest,
      by: "bob",
    });
    expect([invalid.status, invalid.json.error?.code]).toEqual([400, "USAGE"]);
    const onDisk = JSON.parse(await repo.read(`.metator/runs/${runId}/plan.json`)) as { steps: unknown[] };
    expect(onDisk.steps).toHaveLength(3);

    const fromPane = await fetch(`${base}/runs/${runId}/plan`, {
      method: "PUT",
      headers: { "x-metator-pane": "token" },
      body: JSON.stringify({ plan: PLAN, digest: saved.json.data.digest, by: "agent" }),
    });
    expect(fromPane.status).toBe(403);
  }, 60_000);

  test("past its approval gate the plan is read-only: the view says why, a save is refused", async () => {
    expect((await metator(["run", "advance", "pass", "--run", runId], repo.root)).code).toBe(0);
    expect(
      (await metator(["run", "approve", "plan-approval", "--by", "ana", "--run", runId], repo.root)).code,
    ).toBe(0);
    const view = await http("GET", `/runs/${runId}/plan`);
    expect(view.json.data.editable).toBe(false);
    expect(view.json.data.readOnlyBecause).toContain("passed plan-approval");
    const refused = await http("PUT", `/runs/${runId}/plan`, {
      plan: PLAN,
      digest: view.json.data.digest,
      by: "ana",
    });
    expect([refused.status, refused.json.error?.code]).toEqual([400, "TRANSITION_DENIED"]);
  }, 60_000);
});

describe("the run's files from the daemon", () => {
  test("listed with the workflow's expected ones; read; nothing out of the run directory", async () => {
    const list = await http("GET", `/runs/${runId}/artifacts`);
    const names = (list.json.data as unknown as { name: string; expected: boolean }[]).map((a) => [
      a.name,
      a.expected,
    ]);
    expect(names).toContainEqual(["plan.md", false]);
    expect(names).toContainEqual(["build-log.md", true]);
    expect(names.map(([n]) => n)).not.toContain("leak.md");
    const md = await http("GET", `/runs/${runId}/artifacts/plan.md`);
    expect(md.json.data).toEqual({
      name: "plan.md",
      kind: "markdown",
      text: "# The plan\n\nTests first.\n",
      truncated: false,
    });
    for (const name of ["..%2F..%2Fpackage.json", "%2Fetc%2Fhostname.md", "leak.md"]) {
      const r = await http("GET", `/runs/${runId}/artifacts/${name}`);
      expect([r.status, r.json.ok]).toEqual([400, false]);
    }
  }, 60_000);
});

describe("system plans and the map from the daemon", () => {
  test("list, view, edit, approve; an edit after the approval sends the plan back to draft", async () => {
    const list = await http("GET", "/system/plans");
    expect((list.json.data as unknown as { id: string }[]).map((p) => p.id)).toEqual(["add-a-flag"]);
    const view = await http("GET", "/system/plans/add-a-flag");
    expect(view.json.data.waves).toEqual([{ wave: 1, steps: ["api-change"] }]);
    const approved = await http("POST", "/system/plans/add-a-flag/approve", { by: "ana" });
    expect([approved.status, approved.json.data.status]).toEqual([200, "approved"]);
    const plan = approved.json.data.plan as { steps: Record<string, unknown>[] };
    const edited = {
      ...plan,
      steps: [...plan.steps, { id: "api-docs", app: "api", summary: "Document the flag" }],
    };
    const saved = await http("PUT", "/system/plans/add-a-flag", {
      plan: edited,
      digest: approved.json.data.digest,
      by: "bob",
    });
    expect([saved.status, saved.json.data.status, saved.json.data.approval]).toEqual([
      200,
      "draft",
      undefined,
    ]);
    const stale = await http("PUT", "/system/plans/add-a-flag", {
      plan: edited,
      digest: approved.json.data.digest,
      by: "bob",
    });
    expect(stale.status).toBe(409);
    const lint = await http("POST", "/system/plans/add-a-flag/lint", {
      plan: { ...edited, steps: [{ id: "BAD" }] },
    });
    expect((lint.json.data.problems as { field?: string }[]).length).toBeGreaterThan(0);
    const log = await repo.read("metator/system/plans/add-a-flag.edits.jsonl");
    expect(log).toContain('"by":"bob"');
  }, 60_000);

  test("the map: read, save, a stale digest; discovery proposes without writing over it", async () => {
    const view = await http("GET", "/system/map");
    expect([view.json.data.file, view.json.data.editable]).toEqual(["docs/metator/system.yml", true]);
    const map = view.json.data.map as { applications: Record<string, unknown>[] };
    const edited = { ...map, applications: [...map.applications, { id: "web", source: { path: "web" } }] };
    const saved = await http("PUT", "/system/map", { map: edited, digest: view.json.data.digest, by: "ana" });
    expect(saved.status).toBe(200);
    expect(await repo.read("docs/metator/system.yml")).toContain("id: web");
    const stale = await http("PUT", "/system/map", { map: edited, digest: view.json.data.digest, by: "ana" });
    expect(stale.status).toBe(409);
    const found = await http("POST", "/system/discover", { write: true, by: "ana" });
    expect([found.status, found.json.data.written]).toEqual([200, false]);
    expect(found.json.data.proposed).toBeDefined();
  }, 60_000);
});
