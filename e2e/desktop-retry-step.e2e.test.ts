/**
 * "Retry this step" in the app (real daemon, real Chromium, scenario host): a system run escalated
 * because the child run of one of its steps was aborted. Its bar names that step with **Retry
 * this step**; a click (with the person's name) makes the step pending again, the old run kept in
 * its history, so the system run can start a new child for it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";

const ROOT = join(import.meta.dir, "..");
const MAP = `kind: SystemMap
schemaVersion: 2
system: shop
applications:
  - { id: shop-api, kind: service, source: { path: . }, owners: ["@shop/api"] }
  - { id: shop-web, kind: frontend, source: { repo: github.com/shop/shop-web }, owners: ["@shop/web"] }
contracts: []
policies: { deployOrder: providers-first, breaking: expand-contract }
`;
// The child's workflow: one stage nothing passes, so the child stands until a person ends it.
const STUCK = `kind: Workflow
schemaVersion: 2
id: mt-feature
stages:
  - id: build
    gate: { script: "test -f never-there" }
`;
const PLAN = `kind: SystemPlan
schemaVersion: 1
id: add-a-badge
task: Add a badge
status: draft
createdBy: mt-system-planner
strategies: []
steps:
  - { id: web-badge, app: shop-web, summary: Show a badge, contracts: [], dependsOn: [], status: pending }
`;

const ANALYSIS = `kind: SystemAnalysis
schemaVersion: 1
task: Add a badge
map: docs/metator/system.yml
base: HEAD
contracts: []
applications:
  - { id: shop-web, roles: [changed], owners: ["@shop/web"], files: [] }
`;

let folder: string;
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
let daemon: Bun.Subprocess | undefined;
let port = 0;
let env: Record<string, string>;
const at = (name: string) => join(folder, name);
const mt = (repo: string, ...args: string[]) => metator(args, at(repo), env);
const git = (dir: string, ...a: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...a], {
    cwd: dir,
  });
async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}
const base = () => `http://127.0.0.1:${port}`;
const app = (hash: string) => `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(base())}#/${hash}`;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-retry-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-retry-config-"));
  folder = await mkdtemp(join(tmpdir(), "metator-retry-"));
  const config = `kind: MetatorConfig\nschemaVersion: 12\nhosts:\n  metatorCommand: bun ${CLI_ENTRY}\nsupervisor:\n  hostOrder: [scenario]\nsystem:\n  roots: { shop-web: ../shop-web }\n`;
  const repo = async (name: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) await Bun.write(join(at(name), p), t);
    git(at(name), "init", "-q", "-b", "main");
    git(at(name), "add", "-A");
    git(at(name), "commit", "-q", "-m", "init");
  };
  const W13 = await Bun.file(join(ROOT, ".github/metator/workflows/mt-system-change.yml")).text();
  await repo("shop-api", {
    "docs/metator/system.yml": MAP,
    "metator.config.yml": config,
    ".github/metator/workflows/mt-system-change.yml": W13,
    ".gitignore": ".metator/\nmetator/system/\n",
  });
  await repo("shop-web", {
    "src/tag.ts": "export const tag = 1;\n",
    "metator.config.yml": "kind: MetatorConfig\nschemaVersion: 12\nsupervisor:\n  hostOrder: [scenario]\n",
    ".github/metator/workflows/mt-feature.yml": STUCK,
    ".gitignore": ".metator/\n",
  });
  await Bun.write(join(folder, "scenario.yml"), "kind: AgentScenario\nschemaVersion: 1\nagents: {}\n");
  env = {
    METATOR_USER: "ana",
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: join(folder, "scenario.yml"),
    METATOR_GATE_WAIT_MS: "300",
  };
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  port = probe.port as number;
  await probe.stop(true);
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", String(port), "--poll-ms", "100", "--supervise-ms", "0"],
    {
      cwd: folder,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, METATOR_CONFIG_DIR: configDir, ...env },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await until("the daemon", async () => {
    try {
      return (await fetch(`${base()}/state`)).ok ? true : undefined;
    } catch {
      return undefined;
    }
  });
  page = await (await browser()).newPage();
}, 120_000);
afterAll(async () => {
  await page?.close();
  await closeBrowser();
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  site?.stop(true);
  stopProcessesUnder(folder);
  await rm(folder, { recursive: true, force: true });
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
}, 60_000);

describe("Retry this step in the app (real daemon, real Chromium)", () => {
  test("a system run escalated by an aborted child: its bar offers Retry this step; the step is pending again", async () => {
    // The system run, its approved plan and the step's child, made at a terminal.
    const parent = (
      await mt("shop-api", "run", "new", "--workflow", "mt-system-change", "--task", "Add a badge")
    ).json.data as { runId: string };
    await Bun.write(join(at("shop-api"), "metator/system/plans/add-a-badge.yml"), PLAN);
    await Bun.write(join(at("shop-api"), "metator/system/plans/add-a-badge.analysis.yml"), ANALYSIS);
    expect((await mt("shop-api", "system", "plan", "approve", "add-a-badge", "--by", "ana")).code).toBe(0);
    const started = await mt("shop-api", "system", "plan", "run", "add-a-badge", "--run", parent.runId);
    const child = (started.json.data as { started: { run: string }[] }).started[0]?.run as string;
    // The person gives the child up; the system run stops on it.
    await until("the child to stand", async () =>
      ((await mt("shop-web", "run", "status", child)).json.data as { status: string }).status === "escalated"
        ? true
        : undefined,
    );
    expect(
      (await mt("shop-web", "run", "close", child, "--aborted", "--reason", "wrong approach")).code,
    ).toBe(0);
    expect((await mt("shop-api", "system", "plan", "status", "add-a-badge")).code).toBe(0);
    expect(
      (
        await mt(
          "shop-api",
          "run",
          "advance",
          "fail",
          "--run",
          parent.runId,
          "--reason",
          "a child was aborted",
        )
      ).code,
    ).toBe(0);

    await page.goto(app(`run/${parent.runId}/overview`));
    const bar = page.getByTestId("driverbar");
    await bar.waitFor({ timeout: 30_000 });
    const retry = bar.getByTestId("retry-step-web-badge");
    await retry.waitFor({ timeout: 30_000 });
    expect(await bar.getByTestId("retry-aborted-steps").textContent()).toContain(
      "step web-badge in shop-web",
    );
    await retry.click();
    const named = page.getByRole("dialog", { name: "your name" });
    if (await named.isVisible().catch(() => false)) {
      await named.getByLabel("Your name").fill("ana");
      await named.getByRole("button", { name: "Save" }).click();
    }
    const step = await until("the step to be pending again", async () => {
      const view = (await (await fetch(`${base()}/system/plans/add-a-badge?repo=shop-api`)).json()) as {
        data: {
          plan: {
            steps: { id: string; status: string; previousRuns?: { run: string; retriedBy: string }[] }[];
          };
        };
      };
      const s = view.data.plan.steps.find((x) => x.id === "web-badge");
      return s?.status === "pending" ? s : undefined;
    });
    expect([step.previousRuns?.[0]?.run, step.previousRuns?.[0]?.retriedBy]).toEqual([child, "ana"]);
    await mt("shop-api", "run", "close", parent.runId, "--aborted", "--reason", "the test ends it");
  }, 180_000);
});
