/**
 * The engine in a folder of two repositories served by one daemon: the conductor's commands run
 * in the second repository reach that repository (not the first), a run's terminal socket only
 * finds a session (starting it is explicit), and a run that ends closes its panes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
limits: { parallel: 1 }
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.md]
  - id: approval
    description: The human approves the plan
    hitl: true
  - id: build
    owner: mt-implementer
`;
// A run whose plan is a document (plan.json): its approval gate reads the plan's lint.
const PLANNED = `kind: Workflow
schemaVersion: 2
id: planned
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.json]
  - id: plan-approval
    hitl: true
  - id: build
    owner: mt-implementer
`;
const planJson = (path: string) =>
  JSON.stringify({
    kind: "Plan",
    schemaVersion: 1,
    task: "Change a",
    scope: ["*.ts"],
    steps: [
      { id: "S1", action: "modify", path, intent: "change it", rules: [], testsFirst: [], dependsOn: [] },
    ],
  });
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-orchestrator:
    - - say: "conducting"
      - ask: { question: "Go on?", options: [yes, no] }
  mt-planner:
    - - say: "planning"
      - write: { path: "{runDir}/plan.md", text: "# Plan\\n" }
`;

let folder: string;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let env: Record<string, string>;
type Data = Record<string, unknown>;
const at = (name: string) => join(folder, name);
const mt = (repo: string, ...args: string[]) => metator(args, at(repo), env);
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(`${base}${path}`, init);
  return { http: r.status, body: (await r.json()) as { ok: boolean; data: Data; error?: Data } };
};

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "metator-folder-engine-"));
  await Bun.write(join(folder, "scenario.yml"), SCENARIO);
  for (const name of ["alpha", "beta"]) {
    const dir = at(name);
    await mkdir(join(dir, ".github/metator/workflows"), { recursive: true });
    await Bun.write(join(dir, ".github/metator/workflows/demo.yml"), WORKFLOW);
    await Bun.write(join(dir, ".github/metator/workflows/planned.yml"), PLANNED);
    await Bun.write(join(dir, ".gitignore"), ".metator/\n");
    await Bun.write(join(dir, "a.ts"), `export const ${name} = 1;\n`);
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({ name, private: true, scripts: { start: "bun a.ts" } }),
    );
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "-A"],
      [
        "-c",
        "user.email=e@x",
        "-c",
        "user.name=E",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "init",
      ],
    ])
      Bun.spawnSync(["git", ...args], { cwd: dir });
  }
  env = { METATOR_AGENT_SCENARIO: join(folder, "scenario.yml"), METATOR_USER: "ana" };
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: folder,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = daemon.stderr.getReader();
  let text = "";
  base = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
}, 60_000);
afterAll(async () => {
  daemon.kill("SIGTERM");
  await daemon.exited;
  stopProcessesUnder(folder);
  await rm(folder, { recursive: true, force: true });
});

describe("the engine in a folder of repositories (real daemon)", () => {
  let runId = "";

  test("run start in the second repository opens that run's conductor; its workers are read there", async () => {
    runId = data(await mt("beta", "run", "new", "--workflow", "demo", "--task", "Show the currency in beta"))
      .runId as string;
    const started = await mt("beta", "run", "start", "--run", runId);
    expect(started.code).toBe(0);
    expect([(started.json.data as Data).role, (started.json.data as Data).label]).toEqual([
      "conductor",
      "mt-orchestrator",
    ]);
    const workers = await mt("beta", "run", "workers", "--run", runId);
    expect([workers.code, (workers.json.data as Data).runId]).toEqual([0, runId]);
    // The first repository has no such run: the daemon did not look there.
    const layout = await api("/layout?repo=beta");
    expect(JSON.stringify(layout.body.data)).toContain(runId);
    expect(JSON.stringify((await api("/layout?repo=alpha")).body.data)).not.toContain(runId);
  }, 60_000);

  test("a conductor's run at its human gate has the approval card; answering it moves the run; a finished run's panes close", async () => {
    // The conductor moves the run on (here, a person at a terminal): the gate's question exists.
    expect((await mt("beta", "run", "advance", "pass", "--run", runId)).code).toBe(0);
    const card = (
      (await api("/inbox")).body.data as {
        decisions: { runId: string; repo?: string; question: { id: string; stage: string } }[];
      }
    ).decisions.find((d) => d.runId === runId);
    expect([card?.repo, card?.question.stage]).toEqual(["beta", "approval"]);
    const answered = await api(`/runs/${runId}/answer?repo=beta`, {
      method: "POST",
      body: JSON.stringify({ question: card?.question.id, choices: ["Approve"], by: "ana", origin: "inbox" }),
    });
    expect(answered.http).toBe(200);
    const status = data(await mt("beta", "run", "status", runId)) as {
      stage: string;
      approvals: Record<string, { by: string }>;
    };
    expect([status.stage, status.approvals.approval?.by]).toEqual(["build", "ana"]);
    // The run finishes: the daemon closes its panes (the conductor's too), so it reads as done, not idle.
    expect((await mt("beta", "run", "advance", "pass", "--run", runId)).code).toBe(0);
    await until("the finished run's panes to close", async () => {
      const layout = (await api("/layout?repo=beta")).body.data as { panes: { runId?: string }[] };
      return layout.panes.some((p) => p.runId === runId) ? undefined : true;
    });
  }, 60_000);

  test("a run's plan with lint errors: Approve on its gate card is disabled with the reason and refused; fixed, it approves", async () => {
    const planned = data(await mt("alpha", "run", "new", "--workflow", "planned", "--task", "Change a"))
      .runId as string;
    const planFile = join(at("alpha"), ".metator/runs", planned, "plan.json");
    await Bun.write(planFile, planJson("nowhere.ts"));
    expect((await mt("alpha", "run", "advance", "pass", "--run", planned)).code).toBe(0);
    const cardOf = async () =>
      (
        (await api("/inbox")).body.data as {
          decisions: {
            runId: string;
            question: {
              id: string;
              options: { label: string; disabled?: boolean; disabledBecause?: string }[];
            };
          }[];
        }
      ).decisions.find((d) => d.runId === planned)?.question;
    const q = await cardOf();
    const approve = q?.options.find((o) => o.label === "Approve");
    expect(approve?.disabled).toBe(true);
    expect(approve?.disabledBecause).toBe(
      `the plan of run ${planned} has 1 lint error: S1: nowhere.ts does not exist`,
    );
    const refused = await api(`/runs/${planned}/answer?repo=alpha`, {
      method: "POST",
      body: JSON.stringify({ question: q?.id, choices: ["Approve"], by: "ana" }),
    });
    expect([refused.http, refused.body.error?.code]).toEqual([400, "CHECK_FAILED"]);
    expect((data(await mt("alpha", "run", "status", planned)) as { stage: string }).stage).toBe(
      "plan-approval",
    );
    // The plan fixed: the same card approves.
    await Bun.write(planFile, planJson("a.ts"));
    expect((await cardOf())?.options.find((o) => o.label === "Approve")?.disabled).toBeUndefined();
    const answered = await api(`/runs/${planned}/answer?repo=alpha`, {
      method: "POST",
      body: JSON.stringify({ question: q?.id, choices: ["Approve"], by: "ana" }),
    });
    expect(answered.http).toBe(200);
    expect((data(await mt("alpha", "run", "status", planned)) as { stage: string }).stage).toBe("build");
    await mt("alpha", "run", "close", planned, "--aborted", "--reason", "the test ends it");
  }, 60_000);

  test("Discover in a folder with no map yet proposes the whole map, and Write creates it", async () => {
    const preview = await api("/system/discover?repo=alpha", {
      method: "POST",
      body: JSON.stringify({ write: false }),
    });
    const found = preview.body.data as { changes: string[]; mapExists: boolean; written: boolean };
    expect(found.mapExists).toBe(false);
    expect(found.changes).toEqual(
      expect.arrayContaining(["application alpha is not in the map", "application beta is not in the map"]),
    );
    const written = await api("/system/discover?repo=alpha", {
      method: "POST",
      body: JSON.stringify({ write: true, by: "ana" }),
    });
    expect((written.body.data as { written: boolean; mapExists: boolean }).written).toBe(true);
    expect(await Bun.file(join(at("alpha"), "docs/metator/system.yml")).exists()).toBe(true);
    const after = await api("/system/discover?repo=alpha", {
      method: "POST",
      body: JSON.stringify({ write: false }),
    });
    expect([
      (after.body.data as { mapExists: boolean }).mapExists,
      (after.body.data as { changes: string[] }).changes,
    ]).toEqual([true, []]);
  }, 60_000);

  test("a run's terminal socket finds its session and never starts one", async () => {
    const other = data(await mt("alpha", "run", "new", "--workflow", "demo", "--task", "No session yet"))
      .runId as string;
    const seen: Data[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/pty/${other}?repo=alpha&by=ana`);
    ws.onmessage = (m) => seen.push(JSON.parse(String(m.data)) as Data);
    await new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    expect((seen[0]?.error as Data)?.message).toBe(`run ${other} has no terminal session`);
    expect(((await api(`/runs/${other}/pty?repo=alpha`)).body.data as Data).session).toBeNull();
    await mt("alpha", "run", "close", other, "--aborted", "--reason", "the test ends it");
  }, 60_000);
});
