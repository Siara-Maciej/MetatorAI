/**
 * Analysis and plan in the Backlog, in the app (round 17; real daemon, real Chromium, the scenario
 * host only, never a real AI host). An item's analysis is rendered with a freshness badge; a change
 * to a file it cites makes it stale and closes Make plan with the reason. Re-analyse opens the
 * guide's terminal, Make plan the conductor's, at once. A plan view's "Create Backlog item" keeps
 * the plan in the Backlog; from a system plan it makes a parent with a part per step, each with
 * what it waits for. A step's tile opens its detail with "Plan this step", whose planner's terminal
 * the app shows. No browser fixture: what the app shows comes from the daemon's routes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
/** Where the screenshots go when METATOR_SHOTS names a directory. */
const SHOTS = process.env.METATOR_SHOTS;
const PLAN_ID = "prices-in-cents";
const SYSTEM_TASK = "Prices in cents";
const CONFIG = (bin: string) => `kind: MetatorConfig
schemaVersion: 13
hosts:
  metatorCommand: ${join(bin, "metator")}
supervisor:
  hostOrder: [scenario]
`;
// A feature: a plan a person approves, the work, a delivery a person approves.
const FEATURE = `kind: Workflow
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
const MAP = `kind: SystemMap
schemaVersion: 2
system: shop
applications:
  - { id: shop-api, kind: service, source: { path: . }, owners: ["@shop/api"] }
contracts:
  - { id: prices-api, kind: openapi, owner: shop-api, spec: { path: openapi.yaml } }
policies: { deployOrder: none, breaking: expand-contract }
`;
const SYSTEM_PLAN = `kind: SystemPlan
schemaVersion: 1
id: ${PLAN_ID}
task: ${SYSTEM_TASK}
status: draft
createdBy: mt-system-planner
strategies: []
steps:
  - { id: api-model, app: shop-api, summary: A price is a whole number of cents, contracts: [{ id: prices-api, role: change }], dependsOn: [], status: pending }
  - { id: api-endpoint, app: shop-api, summary: The prices endpoint returns cents, contracts: [{ id: prices-api, role: change }], dependsOn: [api-model], status: pending }
  - { id: api-docs, app: shop-api, summary: The API docs say cents, contracts: [], dependsOn: [api-endpoint], status: pending }
`;
const SYSTEM_ANALYSIS = `kind: SystemAnalysis
schemaVersion: 1
task: ${SYSTEM_TASK}
map: docs/metator/system.yml
base: HEAD
contracts:
  - { id: prices-api, owner: shop-api, change: compatible, why: "the same field, a narrower type", consumers: [] }
applications:
  - { id: shop-api, roles: [changed, provider], owners: ["@shop/api"], files: [src/prices.ts, openapi.yaml] }
`;
const PLAN = JSON.stringify({
  kind: "Plan",
  schemaVersion: 1,
  task: "Show prices in cents",
  scope: ["src/**", "test/**"],
  steps: [
    {
      id: "S1",
      action: "create",
      path: "test/prices.test.ts",
      intent: "a failing test of cents",
      rules: [],
      testsFirst: [],
      dependsOn: [],
    },
    {
      id: "S2",
      action: "modify",
      path: "src/prices.ts",
      intent: "prices in cents",
      rules: [],
      testsFirst: ["test/prices.test.ts"],
      dependsOn: ["S1"],
    },
  ],
});
const ANALYSIS = "## Where\n\nTotals round in `src/invoice.ts:1`: half-up, not to even.\n";
// The guide records its analysis of the item it was asked about, then waits; a conductor says what
// it is and waits (nothing here drives a run but the test's own `run drive`).
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-guide:
    - - say: "I am the guide. I read the code for this task."
      - run: 'metator issue analyze --issue i001 --text "Totals round in src/invoice.ts:1, which now says half-even."'
      - say: "Analysis recorded."
      - run: 'sleep 300'
  mt-orchestrator:
    - - say: "I am the conductor of this run. I plan first."
      - run: 'sleep 300'
  mt-planner:
    - - write: { path: "{runDir}/plan.json", text: ${JSON.stringify(PLAN)} }
      - say: "STATUS: done"
  mt-system-scout:
    - - write: { path: "metator/system/plans/${PLAN_ID}.analysis.yml", text: ${JSON.stringify(SYSTEM_ANALYSIS)} }
      - write: { path: "{runDir}/system-analysis.md", text: "# Analysis\\n" }
      - say: "STATUS: done"
  mt-system-planner:
    - - write: { path: "metator/system/plans/${PLAN_ID}.yml", text: ${JSON.stringify(SYSTEM_PLAN)} }
      - write: { path: "{runDir}/system-plan.md", text: "# Plan\\n" }
      - say: "STATUS: done"
`;

let repo: ScratchRepo;
let dist: string;
let configDir: string;
let bin: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let env: Record<string, string>;
const errors: string[] = [];

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}
const app = (hash: string) => `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(base)}#/${hash}`;
const api = async (path: string) =>
  (await (await fetch(`${base}${path}`)).json()) as { ok: boolean; data: never };
const mt = (args: string[], stdin?: string) => metator(args, repo.root, env, stdin);
type Item = {
  id: string;
  title: string;
  status: string;
  parent?: string;
  runId?: string;
  plan?: { runId: string };
  freshness: { analysis?: { state: string; changed?: string[] } };
  children: string[];
  waitsFor: string[];
};
const items = async () => ((await api("/issues")) as { data: { issues: Item[] } }).data.issues;
const shot = async (name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name) });
};
const text = async (testId: string) =>
  (await page
    .getByTestId(testId)
    .first()
    .textContent({ timeout: 1000 })
    .catch(() => "")) ?? "";
const says = (testId: string, words: string) =>
  until(`${testId} to say "${words}"`, async () => ((await text(testId)).includes(words) ? true : undefined));

async function nameIfAsked() {
  const who = page.getByRole("dialog", { name: "your name" });
  if (
    await who.waitFor({ timeout: 1500 }).then(
      () => true,
      () => false,
    )
  ) {
    await who.getByLabel("Your name").fill("ana");
    await who.getByRole("button", { name: "Save" }).click();
  }
}

/** Approves the human gate `stage` of `runId` once it waits. */
async function approve(runId: string, stage: string) {
  type Decision = { runId: string; question: { id: string; stage: string } };
  const d = await until(`the ${stage} card of ${runId}`, async () =>
    ((await mt(["inbox"])).json.data as { decisions: Decision[] }).decisions.find(
      (x) => x.runId === runId && x.question.stage === stage,
    ),
  );
  expect((await mt(["run", "answer", d.question.id, "--run", runId, "--choice", "Approve"])).code).toBe(0);
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-backlog-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-backlog-config-"));
  bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  chmodSync(join(bin, "metator"), 0o755);
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nmetator/system/\nscenario.yml\n");
  await repo.write("metator.config.yml", CONFIG(bin));
  await repo.write(".github/metator/workflows/mt-feature.yml", FEATURE);
  await repo.write(
    ".github/metator/workflows/mt-system-change.yml",
    await Bun.file(join(ROOT, ".github/metator/workflows/mt-system-change.yml")).text(),
  );
  await repo.write("docs/metator/system.yml", MAP);
  await repo.write("openapi.yaml", "openapi: 3.0.0\ninfo: { title: prices, version: 1.0.0 }\npaths: {}\n");
  await repo.write("src/invoice.ts", "export const total = (n: number) => Math.round(n);\n");
  await repo.write("src/prices.ts", "export const price = (amount: number) => ({ amount });\n");
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = {
    METATOR_CONFIG_DIR: configDir,
    METATOR_USER: "ana",
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    METATOR_NO_REAL_HOSTS: "1",
    METATOR_GATE_WAIT_MS: "300",
    METATOR_CLAUDE_BIN: "/nonexistent/claude",
    METATOR_COPILOT_BIN: "/nonexistent/copilot",
    METATOR_OPENCODE_BIN: "/nonexistent/opencode",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0", "--intake-ms", "0"],
    {
      cwd: repo.root,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = daemon.stderr.getReader();
  let out = "";
  base = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    out += new TextDecoder().decode(value);
    const line = out.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
  void (async () => {
    for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return;
  })();
  void (async () => {
    const r = daemon.stdout.getReader();
    for (;;) if ((await r.read().catch(() => ({ done: true }))).done) return;
  })();
  page = await (await browser()).newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
}, 120_000);

afterAll(async () => {
  await page?.close();
  await closeBrowser();
  const runs = ((await mt(["run", "list"]).catch(() => ({ json: { data: [] } }))).json.data ?? []) as {
    runId: string;
  }[];
  for (const r of runs) await mt(["run", "stop", r.runId]).catch(() => undefined);
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  stopProcessesUnder(repo.root);
  site?.stop(true);
  await repo?.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
}, 60_000);

describe("analysis and plan in the Backlog (round 17)", () => {
  test("an item's analysis with its badge: fresh, then stale once a cited file changes, and Make plan closed with why", async () => {
    // The chat agent's "analyse": the analysis recorded as a Backlog item.
    const made = await mt(["issue", "analyze", "--title", "Round the totals", "--text", "-"], ANALYSIS);
    expect([made.code, made.json.error ?? null]).toEqual([0, null]);
    const [item] = await items();
    expect(item?.id).toBe("i001");
    await page.goto(app("backlog/i001"));
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    await says("item-analysis", "half-up, not to even");
    // Fresh: Re-analyse, Make plan open, Implement; the row's one word.
    expect(await text("analysis-freshness")).toBe("fresh");
    const actions = page.getByTestId("item-actions");
    expect(await actions.getByRole("button", { name: "Re-analyse" }).count()).toBe(1);
    expect(await actions.getByRole("button", { name: "Make plan" }).isEnabled()).toBe(true);
    expect(await actions.getByRole("button", { name: "Implement", exact: true }).isEnabled()).toBe(true);
    expect(await page.getByTestId("issue-i001").locator(".word").textContent()).toBe("analysed");
    // The analysis is Markdown made readable: its heading is a heading, no HTML from the agent's words.
    expect(await page.getByTestId("item-analysis").locator(".prose-box h3").first().textContent()).toBe(
      "Where",
    );
    await shot("backlog-fresh.png");

    // The cited file changes in the working tree: the analysis no longer says what the code is.
    await repo.write("src/invoice.ts", "export const total = (n: number) => Math.round(n * 100) / 100;\n");
    await says("analysis-freshness", "stale: invoice.ts");
    const plan = actions.getByRole("button", { name: "Make plan" });
    expect(await plan.isDisabled()).toBe(true);
    expect(await plan.getAttribute("title")).toBe("the analysis is stale: src/invoice.ts; re-analyse first");
    expect(await page.getByTestId("why-disabled").first().textContent()).toBe(
      "Make plan: the analysis is stale: src/invoice.ts; re-analyse first",
    );
    expect(await page.getByTestId("issue-i001").locator(".word").textContent()).toBe("stale");
    // The daemon refuses the same, with the same words.
    const refused = (await (
      await fetch(`${base}/issues/i001/plan`, { method: "POST", body: JSON.stringify({ by: "ana" }) })
    ).json()) as { ok: boolean; error?: { message: string } };
    expect([refused.ok, refused.error?.message]).toEqual([
      false,
      "the analysis is stale: src/invoice.ts; re-analyse first",
    ]);
    await shot("backlog-stale.png");
    // Committed, the change still makes it stale: the cited file is not what the analysis read.
    await repo.commit("totals to the cent");
    await Bun.sleep(2500);
    expect((await items()).find((i) => i.id === "i001")?.freshness.analysis?.state).toBe("stale");
    expect(errors).toEqual([]);
  }, 120_000);

  test("Re-analyse opens the guide's terminal; Make plan opens the conductor's", async () => {
    await page.goto(app("backlog/i001"));
    await page.getByTestId("item-actions").getByRole("button", { name: "Re-analyse" }).click();
    await nameIfAsked();
    // The app goes to the guide's pane at once, as "+ New chat" goes to its thread.
    await until("the guide's pane on screen", async () =>
      page.url().includes("#/grid/pane:") ? true : undefined,
    );
    await until("the guide's words", async () =>
      (
        (await page
          .locator(".pane-frame")
          .first()
          .textContent({ timeout: 1000 })
          .catch(() => "")) ?? ""
      ).includes("I am the guide")
        ? true
        : undefined,
    );
    // The guide recorded a new analysis: fresh again, and Make plan opens.
    await until("a fresh analysis", async () =>
      (await items()).find((i) => i.id === "i001")?.freshness.analysis?.state === "fresh" ? true : undefined,
    );
    await page.goto(app("backlog/i001"));
    await says("item-analysis", "which now says half-even");
    expect(await text("analysis-freshness")).toBe("fresh");
    const plan = page.getByTestId("item-actions").getByRole("button", { name: "Make plan" });
    expect(await plan.isEnabled()).toBe(true);
    await plan.click();
    await nameIfAsked();
    // The plan run's conductor in its own pane, on the run's Terminal tab.
    const runId = await until(
      "the plan run",
      async () => (await items()).find((i) => i.id === "i001")?.runId,
    );
    await until("the conductor's terminal on screen", async () =>
      page.url().includes(`#/run/${runId}/terminal`) ? true : undefined,
    );
    await until("the conductor's words", async () =>
      ((await page.locator("body").textContent()) ?? "").includes("I am the conductor") ? true : undefined,
    );
    expect((await items()).find((i) => i.id === "i001")?.status).toBe("in-progress");
    expect(errors).toEqual([]);
  }, 120_000);

  test('a plan view\'s "Create Backlog item" keeps a plan that is not run yet; then it opens that item', async () => {
    // A plan made and approved, nothing built: the run is planned ("plan ready").
    const made = await mt([
      "run",
      "new",
      "--workflow",
      "mt-feature",
      "--task",
      "Show prices in cents",
      "--until",
      "plan",
    ]);
    expect([made.code, made.json.error ?? null]).toEqual([0, null]);
    const runId = (made.json.data as { runId: string }).runId;
    await mt(["run", "drive", "--run", runId, "--host", "scenario", "--detach", "--gate-wait", "300"]);
    await approve(runId, "plan-approval");
    await until("the run planned", async () =>
      ((await mt(["run", "status", runId])).json.data as { status: string }).status === "planned"
        ? true
        : undefined,
    );
    await page.goto(app(`run/${runId}/overview`));
    await says("page-state", "plan ready");
    const create = page.getByTestId("from-plan").first();
    await create.waitFor({ timeout: 20_000 });
    expect(await create.textContent()).toBe("Create Backlog item");
    await create.click();
    await nameIfAsked();
    const parent = await until("the item made from the plan", async () =>
      (await items()).find((i) => i.plan?.runId === runId && !i.parent),
    );
    // The app opens it: its plan with its badge and its run.
    await until("the Backlog on the new item", async () =>
      page.url().endsWith(`#/backlog/${parent.id}`) ? true : undefined,
    );
    await says("item-plan", "Plan");
    expect(await text("plan-freshness")).toBe("fresh");
    expect(await page.getByTestId("item-plan").getByTestId(`run-link-${runId}`).count()).toBe(1);
    expect(await page.getByTestId(`issue-${parent.id}`).locator(".word").textContent()).toBe("plan ready");
    // A single-repository plan has no phases: the parent alone, no parts.
    expect(await page.getByTestId("item-children").count()).toBe(0);
    // Back on the plan, the button opens the item made.
    await page.goto(app(`run/${runId}/overview`));
    await until("Open its Backlog item", async () =>
      (await text("from-plan")) === "Open its Backlog item" ? true : undefined,
    );
    expect(errors).toEqual([]);
  }, 180_000);

  let systemRun = "";
  test("a system plan step's tile opens its detail: what it has, and Plan this step", async () => {
    const made = await mt(["run", "new", "--workflow", "mt-system-change", "--task", SYSTEM_TASK]);
    expect([made.code, made.json.error ?? null]).toEqual([0, null]);
    systemRun = (made.json.data as { runId: string }).runId;
    await mt(["run", "drive", "--run", systemRun, "--host", "scenario", "--detach", "--gate-wait", "300"]);
    type Decision = { runId: string; question: { stage: string } };
    await until("the system plan's approval card", async () =>
      ((await mt(["inbox"])).json.data as { decisions: Decision[] }).decisions.find(
        (d) => d.runId === systemRun && d.question.stage === "plan-approval",
      ),
    );
    await page.goto(app(`run/${systemRun}/overview`));
    const flow = page.getByTestId(`plan-flow-${PLAN_ID}`).first();
    await flow.waitFor({ timeout: 30_000 });
    await flow.locator('[data-node="api-endpoint"]').click();
    const detail = page.getByRole("dialog", { name: "step The prices endpoint returns cents" });
    await detail.waitFor({ timeout: 10_000 });
    const facts = (await detail.getByTestId("step-detail").textContent()) ?? "";
    expect(facts).toContain("shop-api");
    expect(facts).toContain("change prices-api");
    expect(facts).toContain("A price is a whole number of cents");
    // Its app's files from the system analysis.
    expect(await detail.getByTestId("step-files").textContent()).toBe("src/prices.ts, openapi.yaml");
    expect(await detail.getByTestId("step-word").textContent()).toBe("pending");
    expect(await detail.getByRole("button", { name: "Plan this step" }).isEnabled()).toBe(true);
    await shot("step-detail.png");
    // Escape closes the detail, not the page.
    await page.keyboard.press("Escape");
    await detail.waitFor({ state: "detached", timeout: 5000 });
    expect(page.url()).toContain(`#/run/${systemRun}/overview`);
    // The same detail from the task's Board: a step not started is a card in To do.
    await page.goto(app(`board/${encodeURIComponent(`plan:${PLAN_ID}`)}`));
    const card = page.locator('[data-testid^="card-step-"][data-testid$="/api-docs"]');
    await card.waitFor({ timeout: 20_000 });
    await card.click();
    const docs = page.getByRole("dialog", { name: "step The API docs say cents" });
    await docs.waitFor({ timeout: 10_000 });
    expect(await docs.getByTestId("step-detail").textContent()).toContain(
      "The prices endpoint returns cents",
    );
    await docs.getByRole("button", { name: "Close" }).click();
    // Closing the detail leaves the task's board where it was.
    expect(page.url()).toContain("#/board/");
    expect(errors).toEqual([]);
  }, 180_000);

  test("from a system plan: a parent with a part per step, each with what it waits for; the parent counts them", async () => {
    await page.goto(app(`run/${systemRun}/overview`));
    const create = page.getByTestId("from-plan").first();
    await create.waitFor({ timeout: 20_000 });
    expect(await create.textContent()).toBe("Create Backlog item");
    await create.click();
    await nameIfAsked();
    const parent = await until("the parent item", async () =>
      (await items()).find((i) => i.plan?.runId === systemRun && !i.parent),
    );
    await until("the Backlog on the parent", async () =>
      page.url().endsWith(`#/backlog/${parent.id}`) ? true : undefined,
    );
    const all = await items();
    const parts = all.filter((i) => i.parent === parent.id);
    expect(parts.map((p) => p.title)).toEqual([
      "A price is a whole number of cents",
      "The prices endpoint returns cents",
      "The API docs say cents",
    ]);
    const [model, endpoint, docs] = parts as [Item, Item, Item];
    // The list: the parent, then its parts right under it.
    const order = await page
      .locator(".backlog .ld-row.item")
      .evaluateAll((els) => els.map((e) => [e.getAttribute("data-testid"), e.classList.contains("child")]));
    const at = order.findIndex(([id]) => id === `issue-${parent.id}`);
    expect(order.slice(at, at + 4)).toEqual([
      [`issue-${parent.id}`, false],
      [`issue-${model.id}`, true],
      [`issue-${endpoint.id}`, true],
      [`issue-${docs.id}`, true],
    ]);
    expect(await page.getByTestId(`issue-${parent.id}`).locator(".sub").textContent()).toBe("0 of 3 done");
    expect(await page.getByTestId(`issue-${endpoint.id}`).locator(".word").textContent()).toBe("waits");
    expect(await page.getByTestId(`issue-${endpoint.id}`).locator(".sub").textContent()).toBe(
      "waits for A price is a whole number of cents",
    );
    // The parent's detail: its parts, one word each, what each waits for; it starts none itself.
    await says("item-children", "0 of 3 done");
    expect(await page.getByTestId(`child-${model.id}`).textContent()).toContain("open");
    expect(await page.getByTestId(`child-${docs.id}`).textContent()).toContain(
      "waits for The prices endpoint returns cents",
    );
    const implement = page
      .getByTestId("item-actions")
      .getByRole("button", { name: "Implement", exact: true });
    expect(await implement.isDisabled()).toBe(true);
    expect(await implement.getAttribute("title")).toBe("its parts start one by one: implement them");
    await shot("backlog-parent.png");
    // A part waiting for another cannot start yet, and says for what.
    await page.getByTestId(`child-${endpoint.id}`).getByRole("button").click();
    expect(await page.getByTestId("item-parent").textContent()).toContain(SYSTEM_TASK);
    expect(await text("why-disabled")).toBe("Implement: waits for A price is a whole number of cents");
    // The first part done: the parent counts it, and the next part may start.
    expect((await mt(["issue", "close", model.id, "--by", "ana"])).code).toBe(0);
    await says(`issue-${parent.id}`, "1 of 3 done");
    await until("the endpoint part free to start", async () =>
      (await page.getByTestId(`issue-${endpoint.id}`).locator(".word").textContent()) === "open"
        ? true
        : undefined,
    );
    expect(errors).toEqual([]);
  }, 120_000);

  test("Plan this step: its planner's terminal at once; the detail then says planning, with no button", async () => {
    await page.goto(app(`run/${systemRun}/overview`));
    const flow = page.getByTestId(`plan-flow-${PLAN_ID}`).first();
    await flow.waitFor({ timeout: 30_000 });
    await flow.locator('[data-node="api-model"]').click();
    const detail = page.getByRole("dialog", { name: "step A price is a whole number of cents" });
    await detail.waitFor({ timeout: 10_000 });
    await detail.getByRole("button", { name: "Plan this step" }).click();
    await nameIfAsked();
    const planRun = await until("the step's plan run", async () => {
      const v = (await api(`/system/plans/${PLAN_ID}`)) as {
        data: { steps: { id: string; planRunId?: string }[] };
      };
      return v.data.steps.find((s) => s.id === "api-model")?.planRunId;
    });
    await until("the planner's terminal on screen", async () =>
      page.url().includes(`#/run/${planRun}/terminal`) ? true : undefined,
    );
    await page.goto(app(`run/${systemRun}/overview`));
    await flow.waitFor({ timeout: 30_000 });
    await flow.locator('[data-node="api-model"]').click();
    await detail.waitFor({ timeout: 10_000 });
    await until("the step planning", async () =>
      (await detail.getByTestId("step-word").textContent()) === "planning" ? true : undefined,
    );
    expect(await detail.getByRole("button", { name: "Plan this step" }).count()).toBe(0);
    expect(await detail.getByRole("button", { name: "Its terminal" }).count()).toBe(1);
    // The step's Backlog part, made from the plan above.
    expect(await detail.getByRole("link", { name: "its Backlog item ›" }).count()).toBe(1);
    expect(errors).toEqual([]);
  }, 120_000);
});
