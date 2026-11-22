/**
 * Plans in the app, end to end on a real daemon over a real repository: the run's plan (read,
 * lint; a person asks for changes at its gate, the run goes back to its planner with their words,
 * and the revised plan shows the version it replaced and what changed; no one edits it by hand),
 * the run's files (listed, read, nothing out of the run directory), system plans (list, view,
 * approve, lint) and the system map (read, save, a stale digest, proposed from the code).
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
    onFail: { goto: plan, loop: plan }
  - id: build
    owner: mt-implementer
    produces: [build-log.md]
loops: { plan: 2 }
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
  test("read and lint; nobody edits it: the save route is gone", async () => {
    const view = await http("GET", `/runs/${runId}/plan`);
    expect(view.status).toBe(200);
    expect([view.json.data.stage, view.json.data.approvalStage, view.json.data.previous]).toEqual([
      "plan",
      "plan-approval",
      undefined,
    ]);
    const lint = await http("POST", `/runs/${runId}/plan/lint`, { plan: { ...PLAN, scope: [] } });
    expect((lint.json.data.problems as { field?: string }[])[0]?.field).toBe("scope");
    const put = await http("PUT", `/runs/${runId}/plan`, {
      plan: PLAN,
      digest: view.json.data.digest,
      by: "ana",
    });
    expect(put.status).toBe(404);
  }, 60_000);

  test("asking for changes at the gate sends the run back to its planner with the words; the revised plan shows what it replaced", async () => {
    expect((await metator(["run", "advance", "pass", "--run", runId], repo.root)).code).toBe(0);
    const questions = (await metator(["run", "questions", "--run", runId], repo.root)).json.data as {
      questions: { id: string; stage: string }[];
    };
    const gate = questions.questions.find((q) => q.stage === "plan-approval");
    // At a terminal (no drive is started here: the test plays the planner).
    const asked = await metator(
      [
        "run",
        "answer",
        gate?.id as string,
        "--run",
        runId,
        "--choice",
        "Reject",
        "--text",
        "a test for the cap first",
        "--by",
        "ana",
      ],
      repo.root,
    );
    expect(asked.code).toBe(0);
    const status = (await metator(["run", "status", "--run", runId], repo.root)).json.data as {
      stage: string;
      recent: { stage: string; event: string; detail?: string }[];
    };
    expect([status.stage, status.recent.at(-1)]).toEqual([
      "plan",
      { stage: "plan-approval", event: "FAIL", detail: "a test for the cap first" },
    ]);
    // The planner revises the plan (here, the test does what it would): S3 added.
    const revised = {
      ...PLAN,
      steps: [...PLAN.steps, { id: "S3", action: "create", path: "src/cap.test.ts", intent: "cap test" }],
    };
    await repo.write(
      `.metator/runs/${runId}/plan.json`,
      JSON.stringify({ kind: "Plan", schemaVersion: 1, ...revised }),
    );
    const view = await http("GET", `/runs/${runId}/plan`);
    const previous = view.json.data.previous as { plan: { steps: unknown[] }; digest: string; at: string };
    expect(previous.plan.steps).toHaveLength(PLAN.steps.length);
    expect(view.json.data.changes).toEqual(["step added: S3"]);
  }, 60_000);

  test("past its approval gate the plan is read-only: the view says why", async () => {
    expect((await metator(["run", "advance", "pass", "--run", runId], repo.root)).code).toBe(0);
    expect(
      (await metator(["run", "approve", "plan-approval", "--by", "ana", "--run", runId], repo.root)).code,
    ).toBe(0);
    const view = await http("GET", `/runs/${runId}/plan`);
    expect(view.json.data.editable).toBe(false);
    expect(view.json.data.readOnlyBecause).toContain("passed plan-approval");
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
  test("list, view, lint, approve; nobody edits a system plan: the save route is gone", async () => {
    const list = await http("GET", "/system/plans");
    expect((list.json.data as unknown as { id: string }[]).map((p) => p.id)).toEqual(["add-a-flag"]);
    const view = await http("GET", "/system/plans/add-a-flag");
    expect([view.json.data.waves, view.json.data.previous]).toEqual([
      [{ wave: 1, steps: ["api-change"] }],
      undefined,
    ]);
    const approved = await http("POST", "/system/plans/add-a-flag/approve", { by: "ana" });
    expect([approved.status, approved.json.data.status]).toEqual([200, "approved"]);
    const plan = approved.json.data.plan as { steps: Record<string, unknown>[] };
    const put = await http("PUT", "/system/plans/add-a-flag", {
      plan,
      digest: approved.json.data.digest,
      by: "bob",
    });
    expect(put.status).toBe(404);
    const lint = await http("POST", "/system/plans/add-a-flag/lint", {
      plan: { ...plan, steps: [{ id: "BAD" }] },
    });
    expect((lint.json.data.problems as { field?: string }[]).length).toBeGreaterThan(0);
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
