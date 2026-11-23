/**
 * The owner's flow, end to end in the app: a folder of two repositories (shop-api, shop-web), one
 * system task whose plan has four steps (`api-model` and `api-endpoint` in shop-api and
 * `web-price-tag` in shop-web at once, then `web-integration` in shop-web after all three),
 * driven with the scenario host. The task's page draws the plan as a flow (every step, the
 * pending ones dashed, an arrow per dependsOn) and the Board puts every task, then every step of
 * a task, in the column of the phase the daemon sends; a step's page leads back to its task. The two backend steps run side by side, each in a
 * worktree of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";

const ROOT = join(import.meta.dir, "..");
const TASK = "Add a currency to prices";
const PLAN_ID = "add-a-currency-to-prices";
const MAP = `kind: SystemMap
schemaVersion: 2
system: shop
applications:
  - { id: shop-api, kind: service, source: { path: . }, owners: ["@shop/api"] }
  - { id: shop-web, kind: frontend, source: { repo: github.com/shop/shop-web }, owners: ["@shop/web"], consumes: [prices-api] }
contracts:
  - { id: prices-api, kind: openapi, owner: shop-api, spec: { path: openapi.yaml } }
# The plan says the order itself: the price tag is built alongside the API, its integration after both.
policies: { deployOrder: none, breaking: expand-contract }
`;
// The planner words the plan's task its own way: the card still finds the plan, by its id.
const SYSTEM_PLAN = `kind: SystemPlan
schemaVersion: 1
id: ${PLAN_ID}
task: "${TASK}: the API sends the currency, the web shows it"
status: draft
createdBy: mt-system-planner
strategies: []
steps:
  - { id: api-model, app: shop-api, summary: A price carries its currency, contracts: [{ id: prices-api, role: change }], dependsOn: [], status: pending }
  - { id: api-endpoint, app: shop-api, summary: "GET /prices/{sku} returns the currency", contracts: [{ id: prices-api, role: change }], dependsOn: [], status: pending }
  - { id: web-price-tag, app: shop-web, summary: The price tag has room for a currency, contracts: [], dependsOn: [], status: pending }
  - { id: web-integration, app: shop-web, summary: The price tag shows the currency the API sends, contracts: [], dependsOn: [api-model, api-endpoint, web-price-tag], status: pending }
`;
const ANALYSIS = `kind: SystemAnalysis
schemaVersion: 1
task: ${TASK}
map: docs/metator/system.yml
base: HEAD
contracts:
  - { id: prices-api, owner: shop-api, change: compatible, why: "a new optional field", consumers: [{ app: shop-web }] }
applications:
  - { id: shop-api, roles: [changed, provider], owners: ["@shop/api"], files: [openapi.yaml] }
  - { id: shop-web, roles: [consumer], owners: ["@shop/web"], files: [] }
`;
// A child's feature flow: a plan a person approves, the work, a delivery a person approves.
const W1 = `kind: Workflow
schemaVersion: 2
id: mt-feature
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.json]
  - id: plan-approval
    hitl: true
  - id: build
    owner: mt-implementer
  - id: delivery
    hitl: true
`;
// Each child's own plan: a test first, then the change, in files both repositories have.
const CHILD_PLAN = JSON.stringify({
  kind: "Plan",
  schemaVersion: 1,
  task: "The step of the system plan",
  scope: ["src/**", "test/**"],
  steps: [
    {
      id: "S1",
      action: "create",
      path: "test/currency.test.ts",
      intent: "a failing test of the currency",
      rules: [],
      testsFirst: [],
      dependsOn: [],
    },
    {
      id: "S2",
      action: "modify",
      path: "src/index.ts",
      intent: "the currency, as the step says",
      rules: [],
      testsFirst: ["test/currency.test.ts"],
      dependsOn: ["S1"],
    },
  ],
});
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-system-scout:
    - - write: { path: "metator/system/plans/${PLAN_ID}.analysis.yml", text: ${JSON.stringify(ANALYSIS)} }
      - write: { path: "{runDir}/system-analysis.md", text: "# Analysis\\n" }
      - say: "STATUS: done"
  mt-system-planner:
    - - write: { path: "metator/system/plans/${PLAN_ID}.yml", text: ${JSON.stringify(SYSTEM_PLAN)} }
      - write: { path: "{runDir}/system-plan.md", text: "# Plan\\n" }
      - say: "STATUS: done"
  mt-planner:
    - - write: { path: "{runDir}/plan.json", text: ${JSON.stringify(CHILD_PLAN)} }
      - say: "STATUS: done"
  mt-implementer:
    - - say: "STATUS: done"
`;
const NOWHERE = {
  METATOR_COPILOT_BIN: "/nonexistent/copilot",
  METATOR_CLAUDE_BIN: "/nonexistent/claude",
  METATOR_OPENCODE_BIN: "/nonexistent/opencode",
};

let folder: string;
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
let daemon: Bun.Subprocess<"ignore", "ignore", "pipe">;
let base = "";
let env: Record<string, string>;
let parent = "";
const errors: string[] = [];
const at = (name: string) => join(folder, name);
const git = (dir: string, ...a: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...a], {
    cwd: dir,
  });
const mt = (repo: string, ...args: string[]) => metator(args, at(repo), env);
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const app = (hash: string) => `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(base)}#/${hash}`;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}
type Decision = { runId: string; question: { id: string; stage: string } };
/** Approves every human gate of `runs` that waits now, in either repository. */
async function approveWaiting(runIds: readonly string[], stage?: string): Promise<number> {
  let n = 0;
  for (const repo of ["shop-api", "shop-web"]) {
    const inbox = data(await mt(repo, "inbox")) as { decisions: Decision[] };
    for (const d of inbox.decisions)
      if (runIds.includes(d.runId) && (!stage || d.question.stage === stage)) {
        expect(
          (await mt(repo, "run", "answer", d.question.id, "--run", d.runId, "--choice", "Approve")).code,
        ).toBe(0);
        n++;
      }
  }
  return n;
}
type ListedRun = { runId: string; workflow: string; status: string };
const childRuns = async () => [
  ...((data(await mt("shop-api", "run", "list")) as unknown as ListedRun[]) ?? [])
    .filter((r) => r.workflow === "mt-feature")
    .map((r) => ({ ...r, repo: "shop-api" })),
  ...((data(await mt("shop-web", "run", "list")) as unknown as ListedRun[]) ?? []).map((r) => ({
    ...r,
    repo: "shop-web",
  })),
];
const stageOf = async (repo: string, runId: string) =>
  (data(await mt(repo, "run", "status", runId)) as { stage: string }).stage;
/** The state of each node of the plan's flow, as the graph draws it. */
const flowStates = async () =>
  Object.fromEntries(
    await page
      .getByTestId(`plan-flow-${PLAN_ID}`)
      .first()
      .locator("[data-node][data-state]")
      .evaluateAll((els) => els.map((e) => [e.getAttribute("data-node"), e.getAttribute("data-state")])),
  ) as Record<string, string>;
/** The cards of each column of the board, by their titles' first words. */
const boardColumns = async () =>
  Object.fromEntries(
    await Promise.all(
      ["todo", "planning", "in-progress", "review", "done"].map(async (c) => [
        c,
        await page.getByTestId(`board-col-${c}`).locator(".board-card").count(),
      ]),
    ),
  ) as Record<string, number>;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-flow-"));
  const build = Bun.spawn(["bunx", "vite", "build", "--outDir", dist], {
    cwd: join(ROOT, "packages/desktop"),
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
  site = Bun.serve({
    port: 0,
    fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const file = join(dist, path === "/" ? "index.html" : path);
      return file.startsWith(dist) && existsSync(file)
        ? new Response(Bun.file(file))
        : new Response(Bun.file(join(dist, "index.html")));
    },
  });
  folder = await mkdtemp(join(tmpdir(), "metator-flow-"));
  configDir = await mkdtemp(join(tmpdir(), "metator-flow-config-"));
  const W13 = await Bun.file(join(ROOT, ".github/metator/workflows/mt-system-change.yml")).text();
  const config = `kind: MetatorConfig\nschemaVersion: 12\nhosts:\n  metatorCommand: bun ${CLI_ENTRY}\nsupervisor:\n  hostOrder: [scenario]\nsystem:\n  roots: { shop-web: ../shop-web }\n`;
  const repo = async (name: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) await Bun.write(join(at(name), p), t);
    git(at(name), "init", "-q", "-b", "main");
    git(at(name), "add", "-A");
    git(at(name), "commit", "-q", "-m", "init");
  };
  await Bun.write(join(folder, "scenario.yml"), SCENARIO);
  await repo("shop-api", {
    "docs/metator/system.yml": MAP,
    "openapi.yaml": "openapi: 3.0.0\ninfo: { title: prices, version: 1.0.0 }\npaths: {}\n",
    "src/prices.ts": "export const price = (amount: number) => ({ amount });\n",
    "src/index.ts": "export * from './prices.ts';\n",
    "metator.config.yml": config,
    ".github/metator/workflows/mt-system-change.yml": W13,
    ".github/metator/workflows/mt-feature.yml": W1,
    ".gitignore": ".metator/\nmetator/system/\n",
  });
  await repo("shop-web", {
    "src/price-tag.ts": "export const tag = (amount: number) => String(amount);\n",
    "src/index.ts": "export * from './price-tag.ts';\n",
    "metator.config.yml": `kind: MetatorConfig\nschemaVersion: 12\nhosts:\n  metatorCommand: bun ${CLI_ENTRY}\nsupervisor:\n  hostOrder: [scenario]\n`,
    ".github/metator/workflows/mt-feature.yml": W1,
    ".gitignore": ".metator/\n",
  });
  env = {
    ...NOWHERE,
    METATOR_USER: "ana",
    METATOR_AGENT_SCENARIO: join(folder, "scenario.yml"),
    METATOR_HOST: "scenario",
    METATOR_GATE_WAIT_MS: "300",
    METATOR_CONFIG_DIR: configDir,
  };
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0", "--intake-ms", "0"],
    {
      cwd: folder,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const reader = daemon.stderr.getReader();
  let text = "";
  base = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
  const b = await browser();
  page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
}, 120_000);

afterAll(async () => {
  await closeBrowser();
  for (const repo of ["shop-api", "shop-web"]) {
    const runs = ((await mt(repo, "run", "list")).json.data ?? []) as { runId: string }[];
    for (const r of runs) await mt(repo, "run", "stop", r.runId);
  }
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  stopProcessesUnder(folder);
  site.stop(true);
  await rm(folder, { recursive: true, force: true });
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("a decomposed task as a flow and on the board (real daemon, real Chromium)", () => {
  test("the plan approved: every step is on the graph (pending, dashed) and in To do with what it waits for", async () => {
    parent = data(await mt("shop-api", "run", "new", "--workflow", "mt-system-change", "--task", TASK))
      .runId as string;
    await mt(
      "shop-api",
      "run",
      "drive",
      "--run",
      parent,
      "--host",
      "scenario",
      "--detach",
      "--gate-wait",
      "300",
    );
    await until("the plan-approval card", async () => {
      const inbox = data(await mt("shop-api", "inbox")) as { decisions: Decision[] };
      return inbox.decisions.find((d) => d.runId === parent && d.question.stage === "plan-approval");
    }).catch(async (e) => {
      // What the system run did instead: its log says.
      throw new Error(
        `${(e as Error).message}\n${(await Bun.file(join(at("shop-api"), ".metator/runs", parent, "log.md")).text()).slice(-1500)}`,
      );
    });
    // A person approves the plan itself first; the gate card still waits.
    expect((await mt("shop-api", "system", "plan", "approve", PLAN_ID, "--by", "ana")).code).toBe(0);
    // The flow is on the task's own page: the system run's Overview (the old Plan tab leads there).
    await page.goto(app(`run/${parent}/plan`));
    const flow = page.getByTestId(`plan-flow-${PLAN_ID}`).first();
    await flow.waitFor({ timeout: 30_000 });
    // A task's page: its name, one state word, the progress of its steps; no terminal, no ids in sight.
    expect(await page.getByLabel("tabs of this run").getByRole("link").allTextContents()).toEqual([
      "Overview",
      "Changes",
      "Activity",
    ]);
    expect(await page.getByTestId("page-progress").textContent()).toContain("0 of 4 steps done");
    expect(await page.getByTestId("page-state").textContent()).toContain("needs you");
    expect(await page.getByTestId("run-details").getAttribute("open")).toBeNull();
    // The one thing to decide is on the task's page: the plan's approval, the plan in full.
    expect(await page.getByTestId("task-decide").getByTestId("system-plan-line").count()).toBe(1);
    // On Home the same card: its two actions above the plan, in view at 1440x900 without a scroll;
    // the flow open, the step tables folded under it.
    await page.goto(app("inbox"));
    const bar = page.getByRole("article", { name: "decision card" }).getByTestId("decide-bar");
    await bar.waitFor({ timeout: 20_000 });
    const box = await bar.getByRole("button", { name: "Ask for changes" }).boundingBox();
    expect(box && box.y + box.height).toBeLessThanOrEqual(900);
    expect(await bar.locator(".actions .primary").textContent()).toContain("Approve");
    // The plan always in sight on its approval: the flow, then its steps per repository, unfolded,
    // with what each waits for and its contracts.
    const card = page.getByRole("article", { name: "decision card" });
    expect(await card.locator("h1").textContent()).toContain(
      'Approve the plan for "Add a currency to prices"?',
    );
    const tables = card.getByTestId("system-plan-steps");
    expect(await tables.getAttribute("open")).not.toBeNull();
    expect(await tables.locator("summary").textContent()).toBe("4 steps in 2 repositories");
    expect(await card.getByTestId("system-step-web-integration").isVisible()).toBe(true);
    expect(await card.getByTestId("system-step-web-integration").textContent()).toContain(
      "api-model, api-endpoint, web-price-tag",
    );
    expect(await card.getByTestId("system-step-api-model").textContent()).toContain(
      "contracts: prices-api (change)",
    );
    await until("four pending steps", async () => {
      const s = await flowStates();
      return Object.values(s).length === 4 && Object.values(s).every((v) => v === "pending")
        ? true
        : undefined;
    });
    // The flow: the task into wave 1, the three steps of wave 1 into the integration.
    const edges = await until("the six arrows", async () => {
      const e = await flow
        .locator("[data-edge]")
        .evaluateAll((els) => els.map((x) => x.getAttribute("data-edge") as string));
      return e.length === 6 ? e : undefined;
    });
    expect(edges.sort()).toEqual(
      [
        "@task>api-model",
        "@task>api-endpoint",
        "@task>web-price-tag",
        "api-model>web-integration",
        "api-endpoint>web-integration",
        "web-price-tag>web-integration",
      ].sort(),
    );
    expect(await flow.locator('[data-node="web-integration"]').getAttribute("aria-label")).toBe(
      "web-integration · waits for: api-model, api-endpoint, web-price-tag",
    );
    expect(await flow.textContent()).toContain("wave 2");
    // Nowhere else: Overview → Dependencies has one line that leads to the task's page.
    await page.goto(app("overview/dependencies"));
    await page.getByTestId(`task-line-${PLAN_ID}`).waitFor({ timeout: 20_000 });
    expect(await page.getByTestId(`plan-flow-${PLAN_ID}`).count()).toBe(0);
    // The board's top level: the task once, in Planning (its plan's approval waits), 0 of 4 steps done.
    await page.goto(app("board"));
    await page.getByTestId("board").waitFor({ timeout: 20_000 });
    const task = page.getByTestId(`task-plan:${PLAN_ID}`);
    await task.waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("board-col-planning").getByTestId(`task-plan:${PLAN_ID}`).count()).toBe(1);
    expect(await task.textContent()).toContain("0 of 4 steps done");
    // Its own board: the four steps not started in To do, with what they wait for.
    await task.click();
    await page.getByTestId("board-task").waitFor({ timeout: 20_000 });
    await until("the steps in To do", async () => ((await boardColumns()).todo === 4 ? true : undefined));
    expect(await page.getByTestId("board-col-todo").textContent()).toContain(
      "waits for: api-model, api-endpoint, web-price-tag",
    );
  }, 120_000);

  test("wave 1: three child runs at once, the two backend ones each in a worktree; the graph and the board follow", async () => {
    await approveWaiting([parent], "plan-approval");
    const children = await until(
      "three children",
      async () => {
        const c = await childRuns();
        return c.length === 3 ? c : undefined;
      },
      90_000,
    );
    expect(children.map((c) => c.repo).sort()).toEqual(["shop-api", "shop-api", "shop-web"]);
    // The two steps of shop-api work side by side: each in a worktree of its own.
    const worktrees = children
      .filter((c) => c.repo === "shop-api")
      .map(
        (c) =>
          JSON.parse(readFileSync(join(at("shop-api"), ".metator/runs", c.runId, "state.json"), "utf8"))
            .worktree?.path as string | undefined,
      );
    expect(worktrees.every((w) => typeof w === "string")).toBe(true);
    expect(new Set(worktrees).size).toBe(2);
    // Each child waits at its plan's approval: Planning, needs you.
    await until("the children at plan-approval", async () => {
      const stages = await Promise.all(children.map((c) => stageOf(c.repo, c.runId)));
      return stages.every((s) => s === "plan-approval") ? true : undefined;
    });
    await page.goto(app(`run/${parent}/plan`));
    await until("wave 1 on the graph", async () => {
      const s = await flowStates();
      return s["api-model"] === "needs you" &&
        s["web-price-tag"] === "needs you" &&
        s["web-integration"] === "pending"
        ? true
        : undefined;
    });
    // The sidebar: one row for the task, its progress and what needs you; unfolded, its steps by repository.
    const side = page.getByTestId(`side-task-plan:${PLAN_ID}`);
    await until("the task in the sidebar", async () =>
      (await side.textContent())?.includes("3 need you") ? true : undefined,
    );
    expect(await side.textContent()).toContain("0/4");
    expect(await page.locator("aside.sessions .needs .item").count()).toBe(0);
    if ((await side.locator(".task-repo").count()) === 0)
      await side.getByRole("button", { name: /^unfold/ }).click();
    expect(await side.locator(".repo-name").allTextContents()).toEqual(["shop-api", "shop-web"]);
    expect(await side.locator(".task-repo").last().textContent()).toContain(
      "waits for api-model, api-endpoint, web-price-tag",
    );
    // Opening one decision from anywhere shows exactly that card on Home, and Next goes on from it.
    const card = page.getByRole("article", { name: "decision card" });
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      await page.goto(app(`run/${parent}/overview`));
      await side.waitFor({ timeout: 20_000 });
      if ((await side.locator(".task-repo").count()) === 0)
        await side.getByRole("button", { name: /^unfold/ }).click();
      await side.locator(".task-repo .row").filter({ hasText: "needs you" }).nth(i).click();
      // The address names the decision; Home shows exactly that card, not the queue's first.
      const shown = await until(`the address of step row ${i}`, async () =>
        children.find((c) => page.url().includes(`#/inbox/${c.repo}/${c.runId}/`)),
      );
      await until(`the card of ${shown.runId}`, async () =>
        (
          await card
            .getByTestId("card-details")
            .locator(".ctx")
            .textContent()
            .catch(() => "")
        )?.includes(shown.runId)
          ? true
          : undefined,
      );
      seen.add(shown.runId);
    }
    // Each row opened its own card, not the queue's first.
    expect(seen.size).toBe(3);
    // Next goes on from the card that was opened: another card, and its address follows.
    const before = page.url();
    await page.getByRole("button", { name: "Next ›" }).click();
    const after = await until("the next card", async () => (page.url() !== before ? page.url() : undefined));
    const next = children.find((c) => after.includes(`#/inbox/${c.repo}/${c.runId}/`));
    expect(next && !before.includes(next.runId)).toBe(true);
    await until("the next card shown", async () =>
      (
        await card
          .getByTestId("card-details")
          .locator(".ctx")
          .textContent()
          .catch(() => "")
      )?.includes(next?.runId ?? "?")
        ? true
        : undefined,
    );
    // From a step's page: the link of its question opens its own card.
    const one = children[0] as { runId: string; repo: string };
    await page.goto(app(`run/${one.runId}/overview`));
    await page.getByTestId("decision-link").click();
    await until("that step's card", async () =>
      (
        await card
          .getByTestId("card-details")
          .locator(".ctx")
          .textContent()
          .catch(() => "")
      )?.includes(one.runId)
        ? true
        : undefined,
    );
    // A step's page: Overview · Terminal · Changes · Activity, and the breadcrumb back to its task.
    const model = children.find((c) => c.repo === "shop-web") ?? children[0];
    await page.goto(app(`run/${model?.runId}/overview`));
    const crumb = page.getByTestId("breadcrumb");
    await crumb.waitFor({ timeout: 20_000 });
    expect(await crumb.textContent()).toContain(TASK);
    expect(await page.getByLabel("tabs of this run").getByRole("link").allTextContents()).toEqual([
      "Overview",
      "Terminal",
      "Changes",
      "Activity",
    ]);
    expect(await page.getByTestId("step-plan").count()).toBe(1);
    await crumb.getByRole("link").click();
    await until("the task's page", async () =>
      page.url().includes(`#/run/${parent}/overview`) ? true : undefined,
    );
    // The top level: the task in progress, its three steps that need you counted on it.
    await page.goto(app("board"));
    const task = page.getByTestId(`task-plan:${PLAN_ID}`);
    await until("the task in progress", async () =>
      (await page.getByTestId("board-col-in-progress").getByTestId(`task-plan:${PLAN_ID}`).count()) === 1
        ? true
        : undefined,
    );
    expect(await page.getByTestId("board-head-in-progress").textContent()).toContain("3 need you");
    // Its board: the three children wait at their plan's approval, the last step in To do.
    await task.press("Enter");
    await until("three in Planning", async () => ((await boardColumns()).planning === 3 ? true : undefined));
    expect((await boardColumns()).todo).toBe(1);
    expect(await page.getByTestId("board-head-planning").textContent()).toContain("3 need you");
    // Filtered to shop-web only.
    await page.getByLabel("repositories").getByRole("button", { name: "shop-web" }).click();
    await until("shop-web only", async () =>
      (await page.locator(".board-card").count()) === 2 ? true : undefined,
    );
    // The filter is kept for this viewer: back on the board, it is still shop-web.
    await page.reload();
    await page.getByTestId("board").waitFor({ timeout: 20_000 });
    expect(
      await page
        .getByLabel("repositories")
        .getByRole("button", { name: "shop-web" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await page.getByRole("button", { name: "Clear" }).click();
    await page.getByTestId("board-task").waitFor({ timeout: 20_000 });
    // A card opens with Enter; the arrows move between cards.
    await page.getByTestId("board-col-planning").locator(".board-card").first().focus();
    await page.keyboard.press("ArrowLeft");
    expect(
      await page.evaluate(() =>
        document.activeElement?.closest("[data-testid]")?.getAttribute("data-testid"),
      ),
    ).toMatch(/^card-step-/);
    // Escape goes back to all tasks.
    await page.keyboard.press("Escape");
    await until("the top level", async () =>
      (await page.getByTestId("board-task").count()) === 0 ? true : undefined,
    );
    expect(page.url()).toMatch(/#\/board$/);
  }, 180_000);

  test("wave 1 done: web-integration starts; then everything is done, on the task's page and on the board", async () => {
    const firstWave = (await childRuns()).map((c) => c.runId);
    // Each child: its plan approved, then its delivery.
    await until(
      "wave 1 done",
      async () => {
        await approveWaiting(firstWave);
        const c = await childRuns();
        return firstWave.every((id) => c.find((x) => x.runId === id)?.status === "done") ? true : undefined;
      },
      120_000,
    );
    const integration = await until(
      "web-integration started",
      async () => (await childRuns()).find((c) => !firstWave.includes(c.runId)),
      120_000,
    );
    expect(integration.repo).toBe("shop-web");
    await page.goto(app(`run/${parent}/plan`));
    await until("web-integration on the graph", async () => {
      const s = await flowStates();
      return s["api-model"] === "done" && s["web-integration"] !== "pending" ? true : undefined;
    });
    await until(
      "web-integration done and the system run at its delivery",
      async () => {
        await approveWaiting([integration.runId]);
        const s = data(await mt("shop-api", "run", "status", parent)) as { stage: string; status: string };
        if (s.status === "escalated") throw new Error(`the system run escalated: ${JSON.stringify(s)}`);
        return s.stage === "delivery" ? true : undefined;
      },
      120_000,
    );
    await approveWaiting([parent], "delivery");
    await until("the system run done", async () =>
      (data(await mt("shop-api", "run", "status", parent)) as { status: string }).status === "done"
        ? true
        : undefined,
    );
    // Finished work is folded on the Board: Done says how many until it is asked for.
    await page.goto(app("board"));
    const showDone = page.getByTestId("board-col-done").getByTestId("show-finished");
    await until("the task done", async () =>
      (await showDone.textContent().catch(() => ""))?.includes("Show finished (1)") ? true : undefined,
    );
    expect(await page.getByTestId("board-col-done").getByTestId(`task-plan:${PLAN_ID}`).count()).toBe(0);
    await showDone.click();
    await page.getByTestId("board-col-done").getByTestId(`task-plan:${PLAN_ID}`).waitFor({ timeout: 10_000 });
    expect(await page.getByTestId(`task-plan:${PLAN_ID}`).textContent()).toContain("4 of 4 steps done");
    await page.goto(app(`board/${encodeURIComponent(`plan:${PLAN_ID}`)}`));
    await page.getByTestId("board-col-done").getByTestId("show-finished").click();
    await until(
      "its steps in Done",
      async () => ((await boardColumns()).done === 4 ? true : undefined),
      30_000,
    );
    expect((await boardColumns()).todo).toBe(0);
    await page.goto(app(`run/${parent}/plan`));
    const flow = page.getByTestId(`plan-flow-${PLAN_ID}`).first();
    await flow.waitFor({ timeout: 20_000 });
    await until("every step done", async () => {
      const s = await flowStates();
      return Object.values(s).every((v) => v === "done") ? true : undefined;
    });
    expect(errors.filter((e) => !/Notification|favicon/.test(e))).toEqual([]);
  }, 300_000);
});
