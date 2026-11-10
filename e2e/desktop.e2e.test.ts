/**
 * The desktop app end to end (D7, ADR-0078): the built app in a real Chromium over the real
 * daemon. A session is created from the dialog and driven on the scenario host; its gate
 * question reaches the inbox and is answered from the card (what 11a counts); the session screen
 * streams the PTY and lets the attached person type; the other screens render from the same state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: build
    owner: mt-implementer
  - id: approval
    hitl: true
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  session:
    - - say: "hello from the session"
      - ask: { question: "Which rounding?", options: [half-up, half-even] }
      - say: "STATUS: done"
  mt-implementer:
    - - say: "STATUS: done"
`;

let repo: ScratchRepo;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let daemonUrl = "";
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
const errors: string[] = [];

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}
const api = async (path: string) =>
  (await fetch(`${daemonUrl}${path}`)).json() as Promise<{ ok: boolean; data: Record<string, unknown> }>;

beforeAll(async () => {
  // The app, built once.
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-"));
  const build = Bun.spawn(["bunx", "vite", "build", "--outDir", dist], {
    cwd: join(ROOT, "packages/desktop"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (code !== 0) throw new Error(`vite build failed:\n${out}\n${err}`);
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
  // The daemon on a scratch repository with the scenario host; the person's options in a temp dir.
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-config-"));
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: repo.root,
    env: {
      ...process.env,
      METATOR_STATE_DIR: E2E_STATE_DIR,
      METATOR_CONFIG_DIR: configDir,
      METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = daemon.stderr.getReader();
  let text = "";
  daemonUrl = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
  const b = await browser();
  page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/inbox`);
}, 120_000);

afterAll(async () => {
  await closeBrowser();
  daemon.kill("SIGTERM");
  await daemon.exited;
  site.stop(true);
  await repo.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("MetatorAI Desktop (real daemon, real Chromium)", () => {
  test("connects, shows inbox zero, and creates a driven session from the dialog", async () => {
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    await expect(page.getByText("Inbox zero")).toBeTruthy();
    await page.getByRole("button", { name: "+ New session" }).click();
    const dialog = page.getByRole("dialog", { name: "new session" });
    await dialog.getByLabel("Task").fill("Add the discount to the invoice");
    await dialog.getByLabel("Host").selectOption("scenario");
    await dialog.getByLabel("Workspace").uncheck();
    await dialog.getByLabel("Your name").fill("maciej");
    await expect(await dialog.locator("code").textContent()).toContain(
      "metator run init --workflow demo --task",
    );
    await dialog.getByRole("button", { name: "Create in background" }).click();
    const state = await until("the run", async () => {
      const s = await api("/state");
      const runs = s.data.runs as { runId: string }[];
      return runs.length > 0 ? runs : undefined;
    });
    expect(state[0]?.runId).toMatch(/-demo-/);
  }, 60_000);

  test("the gate question arrives in the inbox and is answered from the card without opening the session", async () => {
    const item = page.locator(".needs .item").first();
    await item.waitFor({ timeout: 40_000 });
    await expect(await item.locator(".kind").textContent()).toBe("GATE");
    const card = page.getByLabel("decision card");
    await expect(await card.locator("h1").textContent()).toContain("approval");
    await expect(await card.locator(".footer-cmd").textContent()).toContain("metator run approve approval");
    await card.getByLabel("your name").fill("maciej");
    await card.locator(".actions .primary").click();
    await until("the inbox to empty", async () =>
      (await page.locator(".needs .item").count()) === 0 ? true : undefined,
    );
    const runId = ((await api("/state")).data.runs as { runId: string }[])[0]?.runId as string;
    const activity = (await api(`/runs/${runId}/activity`)).data.entries as {
      type: string;
      origin?: string;
      text: string;
    }[];
    const answer = activity.find((e) => e.type === "answer");
    expect([answer?.origin, answer?.text]).toEqual(["inbox", expect.stringContaining("· maciej")]);
    await until("the run to finish", async () => {
      const runs = (await api("/state")).data.runs as { status: string }[];
      return runs[0]?.status === "done" ? true : undefined;
    });
  }, 60_000);

  test("the session screen streams the PTY; only the attached person types; other screens render", async () => {
    // A second run, undriven: its scenario session is opened by the terminal itself.
    const created = await (
      await fetch(`${daemonUrl}/runs`, {
        method: "POST",
        body: JSON.stringify({ workflow: "demo", task: "Round the totals" }),
      })
    ).json();
    const runId = (created as { data: { run: { runId: string } } }).data.run.runId;
    await page.goto(
      `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/session/${runId}`,
    );
    const term = page.getByTestId(`terminal-${runId}`);
    await term.waitFor({ timeout: 20_000 });
    await until("the session to greet", async () =>
      (await term.textContent())?.includes("hello from the session") ? true : undefined,
    );
    await expect(await page.getByTestId("driverbar").textContent()).toContain("Driver: agent");
    await page.getByTestId("driverbar").getByLabel("your name").fill("maciej");
    await page.getByRole("button", { name: "Attach · a" }).click();
    await until("the lock", async () =>
      (await page.getByTestId("driverbar").textContent())?.includes("maciej") ? true : undefined,
    );
    await page.getByLabel("message to the session").fill("half-up");
    await page.getByRole("button", { name: "Send" }).click();
    await until("the answer echoed", async () =>
      (await term.textContent())?.includes("answer: half-up") ? true : undefined,
    );
    // The run's panes (R4): the conductor's tab with its state; a shell pane opens, streams and closes.
    const panes = page.getByTestId("panes");
    await until("the conductor's tab", async () =>
      (await panes.textContent())?.includes("conductor") ? true : undefined,
    );
    await panes.getByRole("button", { name: "+ Shell" }).click();
    const shellTerm = page.locator('[data-testid^="pane-"]');
    await shellTerm.first().waitFor({ timeout: 20_000 });
    await until("the panel's pane rows", async () =>
      (await page.locator(".sessions .pane-row").count()) >= 2 ? true : undefined,
    );
    await until("the shell tab", async () =>
      (await panes.textContent())?.includes("shell") ? true : undefined,
    );
    await panes.getByTitle(/^close w\d+:p\d+$/).click();
    await until("the shell tab gone", async () =>
      (await panes.textContent())?.includes("shell") ? undefined : true,
    );
    await page.getByRole("button", { name: /Events/ }).click();
    await until("the events table", async () =>
      (await page.locator(".events tbody tr").count()) > 0 ? true : undefined,
    );
    // The workbench (S6): the run is a tab, its stages a strip, its conductor a framed pane.
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/grid`);
    const workbench = page.getByTestId("workbench");
    await workbench.locator(".pane-frame").first().waitFor({ timeout: 20_000 });
    await until("the run's tab", async () =>
      (await workbench.locator(".tabbar").textContent())?.includes("Round the totals") ? true : undefined,
    );
    expect(await page.getByTestId("procstrip").textContent()).toContain("build");
    // prefix+v splits the focused pane: a shell beside it, in the daemon's tree.
    await page.mouse.click(700, 400);
    await page.keyboard.press("Control+b");
    await page.keyboard.press("v");
    await until("two frames", async () =>
      (await workbench.locator(".pane-frame").count()) === 2 ? true : undefined,
    );
    const layout = (await api("/layout")).data as { workspaces: { tabs: { tree?: unknown }[] }[] };
    expect(layout.workspaces.some((w) => w.tabs.some((t) => t.tree !== undefined))).toBe(true);
    // The new shell takes anyone's keys: typed text comes back from the PTY.
    const shellFrame = workbench.locator('.pane-frame:not([aria-label^="conductor"])').first();
    await shellFrame.waitFor({ timeout: 20_000 });
    await shellFrame.locator(".xterm").click();
    await page.keyboard.type("echo hello-from-the-workbench");
    await page.keyboard.press("Enter");
    await until("the echo", async () =>
      (await shellFrame.textContent())?.includes("hello-from-the-workbench") ? true : undefined,
    );
    // prefix+z zooms the focused pane and back; prefix+g opens the go-to picker.
    await page.keyboard.press("Control+b");
    await page.keyboard.press("z");
    await workbench.locator(".split.zoomed").waitFor({ timeout: 5000 });
    await page.keyboard.press("Control+b");
    await page.keyboard.press("z");
    await until("unzoomed", async () =>
      (await workbench.locator(".split.zoomed").count()) === 0 ? true : undefined,
    );
    await page.keyboard.press("Control+b");
    await page.keyboard.press("g");
    const picker = page.getByRole("dialog", { name: "Go to" });
    await picker.waitFor({ timeout: 5000 });
    expect(await picker.textContent()).toContain("conductor");
    await page.keyboard.press("Escape");
    await until("the picker closed", async () => ((await picker.count()) === 0 ? true : undefined));
    // A right click on a pane is the menu with the splits.
    await shellFrame.click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor({ timeout: 5000 });
    expect(await menu.textContent()).toContain("Split right");
    await page.keyboard.press("Escape");
    // A key rebound in the options works at once: keys.zoom → prefix+f.
    await fetch(`${daemonUrl}/options/keys.zoom`, {
      method: "POST",
      body: JSON.stringify({ scope: "user", value: ["prefix+f"] }),
      headers: { "content-type": "application/json" },
    });
    await until(
      "the app to read the new key",
      async () => ((await workbench.getAttribute("data-zoom-key")) === "prefix+f" ? true : undefined),
      20_000,
    );
    await page.keyboard.press("Control+b");
    await page.keyboard.press("f");
    await workbench.locator(".split.zoomed").waitFor({ timeout: 5000 });
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/graph`);
    await page.getByRole("img", { name: "sessions graph" }).waitFor({ timeout: 20_000 });
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/supervisor`);
    await until("the KPI tiles", async () =>
      (await page.getByTestId("kpi-inbox").textContent())?.includes("100%") ? true : undefined,
    );
    await page.goto(
      `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/briefing/${runId}`,
    );
    await page.getByRole("button", { name: "Mark as read" }).waitFor({ timeout: 20_000 });
    await until("the briefing", async () =>
      (await page.locator(".briefing h2").textContent())?.includes("Since you left") ? true : undefined,
    );
    expect(errors.filter((e) => !/Notification|favicon/.test(e))).toEqual([]);
  }, 90_000);
});
