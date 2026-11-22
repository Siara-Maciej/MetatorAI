/**
 * Analysis and plan in the Backlog (ADR-0096) with the real `metator` on real repositories, on the
 * scenario host only (METATOR_NO_REAL_HOSTS): an analysis recorded as an item, made stale by an
 * edit of a file it cites (Make plan refused), analysed again; a plan made on demand by a run that
 * stops `planned`; Implement from a fresh plan (at build) and a stale one (at the plan's review);
 * a system plan's step planned on its own; items from a system run's plan, a child that waits for
 * its dependency, and a parent that is done by itself. Nothing is committed by MetatorAI.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const MAP = `kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - { id: billing, kind: service, source: { repo: github.com/shop/billing }, owners: ["@billing-team"] }
  - { id: web, kind: frontend, source: { repo: github.com/shop/web }, owners: ["@web-team"], consumes: [billing-api] }
contracts:
  - { id: billing-api, kind: openapi, owner: billing, spec: { path: openapi.yaml } }
policies: { breaking: versioned }
`;
const CONFIG =
  "kind: MetatorConfig\nschemaVersion: 4\nsystem:\n  roots: { billing: ../billing, web: ../web }\n";
// A feature whose plan is made by mt-planner, checked by a script and approved by a person.
const FEATURE = `kind: Workflow
schemaVersion: 3
id: mt-feature
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.json]
  - id: plan-gate
    owner: "script:test -f {runDir}/plan.json"
  - id: plan-approval
    hitl: true
  - id: build
    owner: mt-implementer
`;
const PLAN = JSON.stringify({
  kind: "Plan",
  schemaVersion: 1,
  task: "Round prices half up",
  scope: ["src/**"],
  steps: [{ id: "S1", action: "modify", path: "src/price.ts", intent: "round half up" }],
});
// The planner writes the plan; the implementer waits on a question until the test is done with it.
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-planner:
    - - say: Planning
      - write: { path: "{runDir}/plan.json", text: '${PLAN}' }
      - say: "STATUS: done"
  mt-implementer:
    - - ask: { question: "Wait for the test?", options: [yes] }
  mt-guide:
    - - say: Analysing
      - run: 'metator issue analyze --issue i001 --agent mt-guide --text "Prices round in src/price.ts:1."'
      - say: Recorded on the item
      - run: 'sleep 300'
  mt-orchestrator:
    - - say: conducting
      - run: 'sleep 300'
  mt-chat:
    - - say: chat ready
      - run: 'read -r line; printf "heard: %s\\n" "$line"'
      - run: 'sleep 300'
`;

let folder: string;
let bin: string;
/** The system run of the platform repository, made when its step is planned. */
let systemRun = "";
const at = (name: string) => join(folder, name);
const git = (dir: string, ...a: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...a], {
    cwd: dir,
  });
const env = () => ({
  METATOR_NO_REAL_HOSTS: "1",
  METATOR_USER: "ana",
  METATOR_HOST: "scenario",
  METATOR_AGENT_SCENARIO: join(folder, "scenario.yml"),
  PATH: `${bin}:${process.env.PATH ?? ""}`,
});
const mt = (repo: string, ...args: string[]) => metator(args, at(repo), env());
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const error = (r: { json: Record<string, unknown> }) => r.json.error as { code: string; message: string };

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}

/** A plan run driven in the background on the scenario host: its gate approved by a person, then it stops planned. */
async function approvePlan(repo: string, runId: string): Promise<void> {
  const q = await until("the plan's approval", async () => {
    const qs = (
      data(await mt(repo, "run", "questions", "--run", runId)) as {
        questions: { id: string; stage: string }[];
      }
    ).questions;
    return qs.find((x) => x.stage === "plan-approval");
  });
  expect(
    (await mt(repo, "run", "answer", q.id, "--run", runId, "--choice", "approve", "--by", "ana")).code,
  ).toBe(0);
  await until("the run to stop planned", async () => {
    const status = data(await mt(repo, "run", "status", "--run", runId));
    return status.status === "planned" ? status : undefined;
  });
}

let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let base = "";
const api = async (path: string, init?: RequestInit) =>
  (await (await fetch(`${base}${path}`, init)).json()) as {
    ok: boolean;
    data: Data;
    error?: { message: string };
  };
const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });
const paneText = async (id: string) =>
  String((await api(`/panes/${encodeURIComponent(id)}?lines=200`)).data.text);

async function startDaemon(repo: string): Promise<void> {
  const d = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: at(repo),
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env() },
    stdout: "pipe",
    stderr: "pipe",
  });
  daemon = d;
  const reader = d.stderr.getReader();
  let text = "";
  base = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
  void (async () => {
    while (!(await reader.read()).done);
  })();
}
async function stopDaemon(): Promise<void> {
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  daemon = undefined;
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "metator-backlog-"));
  bin = join(folder, "bin");
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  await chmod(join(bin, "metator"), 0o755);
  await Bun.write(join(folder, "scenario.yml"), SCENARIO);
  const W13 = await Bun.file(
    join(import.meta.dir, "..", ".github/metator/workflows/mt-system-change.yml"),
  ).text();
  const repo = async (name: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) await Bun.write(join(at(name), p), t);
    git(at(name), "init", "-q", "-b", "main");
    git(at(name), "add", "-A");
    git(at(name), "commit", "-q", "-m", "init");
  };
  await repo("platform", {
    "docs/metator/system.yml": MAP,
    "metator.config.yml": CONFIG,
    ".github/metator/workflows/mt-system-change.yml": W13,
    ".gitignore": ".metator/\n",
  });
  const chat = await Bun.file(join(import.meta.dir, "..", ".claude/agents/mt-chat.md")).text();
  for (const name of ["billing", "web"])
    await repo(name, {
      // The daemon's panes run the scenario host; the chat a new thread opens is mt-chat.
      "metator.config.yml": "kind: MetatorConfig\nschemaVersion: 13\nsupervisor:\n  hostOrder: [scenario]\n",
      ".claude/agents/mt-chat.md": chat,
      "package.json": JSON.stringify({ name, private: true }),
      "src/price.ts": "export const round = (n: number) => Math.round(n);\n",
      "src/cart.ts": 'import { round } from "./price.ts";\nexport const total = (n: number) => round(n);\n',
      ".github/metator/workflows/mt-feature.yml": FEATURE,
      ".gitignore": ".metator/\n",
    });
}, 60_000);
afterAll(async () => {
  await stopDaemon();
  stopProcessesUnder(folder);
  await rm(folder, { recursive: true, force: true });
});

describe("analysis and plan in the Backlog (real CLI, scenario host)", () => {
  test("an analysis becomes an item; an edit of a cited file makes it stale and Make plan waits for a new one", async () => {
    const recorded = data(
      await mt(
        "web",
        "issue",
        "analyze",
        "--title",
        "Round prices half up",
        "--text",
        "Prices round in src/price.ts:1; the cart uses it at src/cart.ts:2.",
      ),
    );
    expect(recorded).toMatchObject({
      id: "i001",
      status: "open",
      proposedBy: { agent: "mt-chat" },
      decidedBy: { by: "ana", decision: "added" },
      freshness: { analysis: { state: "fresh" } },
      analysis: { file: ".metator/issues/i001/analysis.md", packages: ["web"] },
    });
    expect(((recorded.analysis as Data).cites as { path: string }[]).map((c) => c.path)).toEqual([
      "src/price.ts",
      "src/cart.ts",
    ]);
    const text = await Bun.file(join(at("web"), ".metator/issues/i001/analysis.md")).text();
    expect(text).toContain("## Deterministic facts");
    expect(text).toContain("- Cited files (2): `src/price.ts`, `src/cart.ts`");
    expect(JSON.parse(await Bun.file(join(at("web"), ".metator/issues/i001.json")).text())).toMatchObject({
      kind: "Issue",
      schemaVersion: 3,
    });

    await Bun.write(
      join(at("web"), "src/price.ts"),
      "export const round = (n: number) => Math.round(n + 0);\n",
    );
    expect(data(await mt("web", "issue", "show", "i001")).freshness).toEqual({
      analysis: { state: "stale", changed: ["src/price.ts"] },
    });
    const refused = await mt("web", "issue", "plan", "i001");
    expect([refused.code, error(refused).message]).toEqual([
      64,
      "the analysis is stale: src/price.ts; re-analyse first",
    ]);
    const again = data(
      await mt(
        "web",
        "issue",
        "analyze",
        "--issue",
        "i001",
        "--text",
        "Prices round in src/price.ts:1 (now with + 0).",
      ),
    );
    expect(again.freshness).toEqual({ analysis: { state: "fresh" } });
    git(at("web"), "commit", "-qam", "round");
  });

  test("Make plan: a run that stops planned; the item gets the plan; Implement starts at build", async () => {
    const plan = data(await mt("web", "issue", "plan", "i001", "--session"));
    const runId = plan.runId as string;
    expect(plan.issue).toMatchObject({ status: "in-progress", runId });
    // No daemon serves the repository: the plan run is driven in the background on the scenario host.
    expect(String(plan.noSession)).toContain("daemon");
    const task = await Bun.file(join(at("web"), `.metator/runs/${runId}/task.md`)).text();
    expect(task).toContain("## Analysis\n\nPrices round in src/price.ts:1 (now with + 0).");
    await approvePlan("web", runId);
    const item = data(await mt("web", "issue", "show", "i001"));
    expect(item).toMatchObject({
      status: "open",
      plan: { runId, kind: "plan", file: ".metator/issues/i001/plan.json" },
      freshness: { plan: { state: "fresh" } },
      planRun: { runId, status: "planned", stage: "planned" },
      planSummary: "Round prices half up\n\n- S1 modify src/price.ts: round half up\n",
    });

    const started = data(await mt("web", "issue", "start", "i001", "--no-worktree", "--allow-dirty"));
    expect(started.mode).toBe("plan-from");
    const run = data(await mt("web", "run", "status", "--run", started.runId as string));
    expect([run.stage, run.status]).toEqual(["build", "active"]);
    const record = JSON.parse(
      await Bun.file(join(at("web"), `.metator/runs/${started.runId}/state.json`)).text(),
    ) as Data;
    expect(record).toMatchObject({ schemaVersion: 9, planFrom: { run: runId, from: "build" } });
    // The item had no thread: its run continues in a new one, from the item.
    const thread = data(await mt("web", "thread", "show", (started.thread as { id: string }).id));
    expect(thread).toMatchObject({ from: { issue: "i001" }, runs: [started.runId] });
  }, 120_000);

  test("Implement with a stale plan starts at the plan's review", async () => {
    (await mt("web", "issue", "add", "Show totals", "--by", "ana")).json;
    const plan = data(await mt("web", "issue", "plan", "i002", "--session"));
    await approvePlan("web", plan.runId as string);
    await Bun.write(
      join(at("web"), "src/price.ts"),
      "export const round = (n: number) => Math.round(n * 1);\n",
    );
    expect((data(await mt("web", "issue", "show", "i002")).freshness as Data).plan).toEqual({
      state: "stale",
      changed: ["src/price.ts"],
    });
    const started = data(await mt("web", "issue", "start", "i002", "--no-worktree", "--allow-dirty"));
    expect(started.mode).toBe("plan-review");
    expect(data(await mt("web", "run", "status", "--run", started.runId as string)).stage).toBe("plan-gate");
    git(at("web"), "checkout", "--", "src/price.ts");
    expect(
      (await findUnversioned(at("web"), [".metator/issues", ".metator/threads"], ["**/analysis.md"]))
        .unversioned,
    ).toEqual([]);
  }, 120_000);

  test("Plan this step: a system plan's step planned on its own in its repository", async () => {
    expect(
      (await mt("platform", "system", "plan", "new", "Rename refunds", "--breaking", "billing-api")).code,
    ).toBe(0);
    expect((await mt("platform", "system", "plan", "approve", "rename-refunds")).code).toBe(0);
    const system = data(
      await mt(
        "platform",
        "run",
        "new",
        "--workflow",
        "mt-system-change",
        "--task",
        "Rename refunds",
        "--allow-dirty",
      ),
    );
    const parent = system.runId as string;
    systemRun = parent;
    const planned = data(
      await mt("platform", "system", "plan", "step-plan", "rename-refunds", "web-migrate", "--run", parent),
    );
    expect([planned.step, planned.app, planned.root]).toEqual(["web-migrate", "web", at("web")]);
    const child = planned.run as string;
    await approvePlan("web", child);
    const record = JSON.parse(
      await Bun.file(join(at("web"), `.metator/runs/${child}/state.json`)).text(),
    ) as Data;
    expect(record).toMatchObject({
      until: "plan",
      parent,
      system: { plan: "rename-refunds", step: "web-migrate" },
    });
    const plan = await Bun.file(join(at("platform"), "metator/system/plans/rename-refunds.yml")).text();
    expect(plan).toContain(`planRunId: ${child}`);
    expect(plan).toContain("schemaVersion: 3");
  }, 120_000);

  test("items from a system run's plan: a parent, a child per step; a child waits; the parent is done by itself", async () => {
    const parent = systemRun;
    const made = data(await mt("platform", "issue", "from-plan", "--run", parent)) as {
      parent: Data;
      children: Data[];
    };
    expect(made.parent).toMatchObject({
      id: "i001",
      title: "Rename refunds",
      plan: { kind: "system-plan", runId: parent, file: ".metator/issues/i001/system-plan.yml" },
      children: ["i002", "i003"],
      progress: { done: 0, of: 2 },
    });
    expect(made.children.map((c) => [c.id, c.dependsOn, c.waitsFor, (c.step as Data).stepId])).toEqual([
      ["i002", [], [], "billing-bump"],
      ["i003", ["i002"], ["i002"], "web-migrate"],
    ]);
    const waits = await mt("platform", "issue", "start", "i003");
    expect([waits.code, error(waits).message]).toEqual([
      64,
      "issue i003 waits for i002 (open): start it when they are done",
    ]);
    const again = await mt("platform", "issue", "from-plan", "--run", parent);
    expect(error(again).message).toBe(`the plan of run ${parent} is already in the Backlog as i001`);
    for (const id of ["i002", "i003"]) expect((await mt("platform", "issue", "close", id)).code).toBe(0);
    expect(data(await mt("platform", "issue", "show", "i001"))).toMatchObject({
      status: "done",
      progress: { done: 2, of: 2 },
    });
  }, 60_000);
});

describe("the Backlog's buttons through the daemon (scenario host)", () => {
  let planRun = "";

  test("Analyse opens the guide in a pane; its analysis lands on the item", async () => {
    await startDaemon("billing");
    expect((await mt("billing", "issue", "add", "Round prices", "--by", "ana")).code).toBe(0);
    const opened = await post("/issues/i001/analyze", { by: "ana", host: "scenario" });
    expect(opened.ok).toBe(true);
    const pane = opened.data.pane as { id: string; label: string; process: { agent: string } };
    expect([pane.label, pane.process.agent]).toEqual(["analyse i001", "mt-guide"]);
    const item = await until("the guide's analysis", async () => {
      const got = (await api("/issues/i001")).data;
      return got.analysis ? got : undefined;
    });
    expect(item).toMatchObject({
      freshness: { analysis: { state: "fresh" } },
      analysis: { file: ".metator/issues/i001/analysis.md" },
    });
    expect(String(item.analysisText)).toContain("Prices round in src/price.ts:1.\n\n## Deterministic facts");
    expect(await paneText(pane.id)).toContain("Recorded on the item");
  }, 120_000);

  test("Make plan opens the plan run's conductor; once approved the item has its plan", async () => {
    const planned = await post("/issues/i001/plan", { by: "ana", host: "scenario" });
    expect(planned.ok).toBe(true);
    planRun = planned.data.runId as string;
    expect(planned.data.session).toMatchObject({ host: "scenario" });
    // The test plays the plan's stages: the plan written, its gate passed, a person approves it.
    await Bun.write(join(at("billing"), `.metator/runs/${planRun}/plan.json`), PLAN);
    for (const event of ["pass", "pass"])
      expect((await mt("billing", "run", "advance", event, "--run", planRun)).code).toBe(0);
    const approved = await mt("billing", "run", "approve", "plan-approval", "--run", planRun, "--by", "ana");
    expect(approved.json.error).toBeUndefined();
    const item = (await api("/issues/i001")).data;
    expect(item).toMatchObject({
      status: "open",
      plan: { runId: planRun, kind: "plan" },
      planRun: { status: "planned" },
      freshness: { plan: { state: "fresh" } },
    });
    const listed = (await api("/issues")).data.issues as Data[];
    expect(listed[0]).toMatchObject({ id: "i001", children: [], waitsFor: [] });
    // The plan is the item's already.
    const again = await post("/issues/from-plan", { runId: planRun, by: "ana" });
    expect(again.error?.message).toBe(`the plan of run ${planRun} is already in the Backlog as i001`);
  }, 120_000);

  test("Implement: the run from the plan in its own pane, and a new thread whose chat gets the item's files", async () => {
    const started = await post("/issues/i001/start", {
      by: "ana",
      host: "scenario",
      worktree: false,
      allowDirty: true,
    });
    expect(started.ok).toBe(true);
    expect(started.data.mode).toBe("plan-from");
    expect(started.data.session).toMatchObject({ host: "scenario" });
    const thread = started.data.thread as { id: string; paneId: string };
    expect(thread.paneId).toBeDefined();
    // The screen wraps a long line: its rows are read as one.
    await until("the carried line in the new chat", async () =>
      (await paneText(thread.paneId))
        .replaceAll("\n", "")
        .includes(
          'heard: [metator] Carried over: Backlog item i001 "Round prices" started. Analysis: .metator/issues/i001/analysis.md. Plan: .metator/issues/i001/plan.json.',
        )
        ? true
        : undefined,
    );
    const t = (await api(`/threads/${thread.id}`)).data;
    expect(t).toMatchObject({ from: { issue: "i001" }, runs: [started.data.runId] });
    expect((await api("/issues/i001")).data).toMatchObject({ status: "in-progress", threadId: thread.id });
    await stopDaemon();
  }, 120_000);

  test("Plan this step through the daemon: the step's run in its repository stops at its plan", async () => {
    await startDaemon("platform");
    const planned = await post("/system/plans/rename-refunds/steps/billing-bump/plan", { by: "ana" });
    expect(planned.ok).toBe(true);
    expect([planned.data.step, planned.data.root]).toEqual(["billing-bump", at("billing")]);
    const child = planned.data.run as string;
    const record = JSON.parse(
      await Bun.file(join(at("billing"), `.metator/runs/${child}/state.json`)).text(),
    ) as Data;
    expect(record).toMatchObject({ until: "plan", parent: systemRun });
    const view = (await api("/system/plans/rename-refunds")).data as { steps: Data[] };
    expect(view.steps.find((s) => s.id === "billing-bump")).toMatchObject({
      planRunId: child,
      summary: expect.any(String),
      planRun: { runId: child, root: at("billing") },
    });
    // Asked again while it plans: refused.
    const again = await post("/system/plans/rename-refunds/steps/billing-bump/plan", { by: "ana" });
    expect(again.error?.message).toBe(`step billing-bump is being planned already: run ${child}`);
    await stopDaemon();
    stopProcessesUnder(at("billing"));
  }, 120_000);
});
