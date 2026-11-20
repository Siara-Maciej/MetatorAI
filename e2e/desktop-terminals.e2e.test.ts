/**
 * Terminals by task (round 8), in the desktop app on a real daemon: a task run with its
 * conductor, a child run (`run new --parent`) with its conductor and a worker it delegated. The
 * task's view shows its main terminal and one tile per repository session, without the worker;
 * the session's badge counts its sub-terminals and opens its own view (its conductor and its
 * worker) with "Tasks › task › session" back; the go-to picker lists the hierarchy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
/** Where a screenshot of the state is kept when METATOR_SHOTS names a directory. */
const SHOTS = process.env.METATOR_SHOTS;
const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
// The conductor says what it does and waits for a word on its own terminal: no question mark,
// so the screen is no prompt a person must answer.
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-orchestrator:
    - - say: "I am the conductor of this run. I delegate the build to a worker and collect its result."
      - ask: { question: "Type here to talk to the conductor.", options: [go on] }
  mt-implementer:
    - - say: "Building the step."
      - ask: { question: "Type here to talk to the worker.", options: [go on] }
`;
const NOWHERE = {
  METATOR_COPILOT_BIN: "/nonexistent/copilot",
  METATOR_CLAUDE_BIN: "/nonexistent/claude",
  METATOR_OPENCODE_BIN: "/nonexistent/opencode",
};

let repo: ScratchRepo;
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
let daemon: Bun.Subprocess<"ignore", "ignore", "pipe">;
let base = "";
let env: Record<string, string>;
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
const app = (hash: string) => `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(base)}#/${hash}`;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-terminals-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-terminals-config-"));
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = {
    ...NOWHERE,
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    METATOR_CONFIG_DIR: configDir,
  };
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: repo.root,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
    stdout: "ignore",
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
  const b = await browser();
  page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
}, 120_000);

afterAll(async () => {
  await closeBrowser();
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  // The conductors the test started work in the repository: nothing outlives the test.
  stopProcessesUnder(repo.root);
  site.stop(true);
  await repo.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("terminals by task (real daemon, real Chromium)", () => {
  test("a task's main terminal and a tile per session; a session's own view has its sub-terminals", async () => {
    const make = async (args: string[]) =>
      (
        (await metator(["run", "new", "--workflow", "demo", ...args], repo.root, env)).json.data as {
          runId: string;
        }
      ).runId;
    const task = await make(["--task", "Prices in the customer's currency"]);
    const child = await make(["--task", "The price model", "--parent", task]);
    expect((await metator(["run", "start", "--run", task], repo.root, env)).code).toBe(0);
    expect((await metator(["run", "start", "--run", child], repo.root, env)).code).toBe(0);
    const delegated = await metator(
      ["run", "delegate", "build", "--agent", "mt-implementer", "--card", "Build the step", "--run", child],
      repo.root,
      env,
    );
    expect(delegated.code).toBe(0);
    const layout = async () =>
      (
        (await (await fetch(`${base}/layout`)).json()) as {
          data: { panes: { id: string; runId?: string; role: string }[] };
        }
      ).data.panes;
    const panes = await until("three panes", async () => {
      const p = await layout();
      return p.length >= 3 ? p : undefined;
    });
    const of = (runId: string, role: string) =>
      panes.find((p) => p.runId === runId && p.role === role)?.id as string;
    const [taskConductor, childConductor, worker] = [
      of(task, "conductor"),
      of(child, "conductor"),
      of(child, "worker"),
    ];
    // One task: Terminals opens on it.
    await page.goto(app("grid"));
    const view = page.getByTestId("task-view");
    await view.waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("terminals-task").textContent()).toBe("Prices in the customer's currency");
    // Its main terminal and one tile per repository session; the worker is not on this view.
    await until("the two tiles", async () =>
      (await view.locator(".tile").count()) === 2 ? true : undefined,
    );
    expect(await page.getByTestId(`tile-${taskConductor}`).locator(".tile-label").textContent()).toContain(
      "main terminal",
    );
    expect(await page.getByTestId(`tile-${childConductor}`).count()).toBe(1);
    expect(await page.getByTestId(`tile-${worker}`).count()).toBe(0);
    // The session's badge counts its sub-terminals and opens its own view.
    const badge = page.getByTestId(`open-session-${child}`);
    await until("the badge", async () =>
      (await badge.textContent())?.includes("1 sub-terminal") ? true : undefined,
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "terminals-task-view.png") });
    await badge.click();
    const session = page.getByTestId("session-view");
    await session.waitFor({ timeout: 20_000 });
    expect(page.url()).toContain(`#/grid/task/${task}/${child}`);
    expect(await page.getByTestId(`tile-${childConductor}`).count()).toBe(1);
    expect(await page.getByTestId(`tile-${worker}`).count()).toBe(1);
    expect(await page.getByTestId(`tile-${taskConductor}`).count()).toBe(0);
    // Every pane is a live terminal there: the worker's output is on its screen.
    await until("the worker's screen", async () =>
      (await page.getByTestId(`frame-${worker}`).textContent())?.includes("Building the step")
        ? true
        : undefined,
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "terminals-session-view.png") });
    // The go-to picker lists the hierarchy: task › repository › worker.
    await page.getByTestId(`frame-${worker}`).click();
    await page.keyboard.press("Control+b");
    await page.keyboard.press("g");
    const go = page.getByRole("dialog", { name: "Go to" });
    await go.waitFor({ timeout: 5000 });
    expect(await go.textContent()).toContain(
      "Prices in the customer's currency › this repository › mt-implementer",
    );
    await page.keyboard.press("Escape");
    // The worker reports and is collected: its pane stays, read-only, with what ended it.
    const workerName = ((await layout()).find((p) => p.id === worker) as { worker?: { name: string } })
      ?.worker?.name as string;
    for (const args of [
      [
        "run",
        "result",
        "--worker",
        workerName,
        "--status",
        "done",
        "--summary",
        "the price model is in",
        "--run",
        child,
      ],
      ["run", "collect", workerName, "--run", child],
    ])
      expect((await metator(args, repo.root, env)).code).toBe(0);
    const banner = page.getByTestId(`ended-${worker}`);
    await until("the finished banner", async () =>
      (await banner.textContent().catch(() => ""))?.includes("Finished — the price model is in")
        ? true
        : undefined,
    );
    expect(await page.getByTestId(`tile-${worker}`).count()).toBe(1);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "terminals-worker-finished.png") });
    // On the task's view the session's badge says so.
    await page.getByTestId("terminals-task").click();
    await until("the badge with the finished worker", async () =>
      (await badge.textContent())?.includes("1 sub-terminal · 1 finished") ? true : undefined,
    );
    // "Close finished (1)" on the task's view closes it too: a finished sub-terminal is the
    // task's, though no tile of this view shows it.
    expect(await page.getByTestId("close-finished").textContent()).toBe("Close finished (1)");
    await page.getByTestId("close-finished").click();
    await until("the finished pane closed", async () =>
      (await layout()).some((p) => p.id === worker) ? undefined : true,
    );
    // The breadcrumb leads back to the task's view; "Workspaces" is the workspaces' tabs as before.
    await page.getByTestId("terminals-task").click();
    await view.waitFor({ timeout: 20_000 });
    expect(page.url()).toContain(`#/grid/task/${task}`);
    await page.getByRole("link", { name: "Workspaces" }).click();
    await page.getByTestId("by-task").waitFor({ timeout: 20_000 });
    for (const id of [task, child])
      await metator(
        ["run", "close", "--run", id, "--aborted", "--reason", "the test ends here"],
        repo.root,
        env,
      );
    expect(errors.filter((e) => !/Notification|favicon/.test(e))).toEqual([]);
  }, 120_000);
});
