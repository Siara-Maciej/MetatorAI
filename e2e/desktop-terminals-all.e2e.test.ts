/**
 * Every terminal at once (round 22), in the desktop app on a real daemon: a task run, a child run
 * and the child's worker; the child asks a question, so its agents' terminals ask. The All view
 * groups them by task and session; "? N asks" on the main terminal goes to each asking terminal
 * (it flashes and gets the keyboard); "↑ parent" goes to the terminal that started one; Alt+click
 * on a filter chip shows only that value (again: all); the tree shows a hidden terminal; a
 * terminal that appears is marked new with a toast; the tree's eye hides a branch or a task; the
 * sidebar and the tree fold to their narrow
 * versions and stay folded after a reload.
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
// A task's title is the person's whole sentence at times: the view must not grow wider than the window.
const TITLE =
  "Prices in the customer's currency, with tax by country, rounded per invoice line, in the storefront, the API and every invoice";
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
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-all-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-all-config-"));
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

describe("every terminal at once (real daemon, real Chromium)", () => {
  test("groups, asks and parent links that focus, Alt+click filters, the tree, a new terminal", async () => {
    const make = async (args: string[]) =>
      (
        (await metator(["run", "new", "--workflow", "demo", ...args], repo.root, env)).json.data as {
          runId: string;
        }
      ).runId;
    const task = await make(["--task", TITLE]);
    const child = await make(["--task", "The price model", "--parent", task]);
    expect((await metator(["run", "start", "--run", task], repo.root, env)).code).toBe(0);
    expect((await metator(["run", "start", "--run", child], repo.root, env)).code).toBe(0);
    expect(
      (
        await metator(
          [
            "run",
            "delegate",
            "build",
            "--agent",
            "mt-implementer",
            "--card",
            "Build the step",
            "--run",
            child,
          ],
          repo.root,
          env,
        )
      ).code,
    ).toBe(0);
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
    // The child run asks the person: its agents' terminals ask.
    expect(
      (
        await metator(
          ["run", "ask", "Separate line or inline?", "--option", "separate", "inline", "--run", child],
          repo.root,
          env,
        )
      ).code,
    ).toBe(0);
    await page.goto(app("grid/all"));
    await page.getByTestId("all-view").waitFor({ timeout: 30_000 });
    const tile = (id: string) => page.getByTestId(`tile-${id}`);
    await until("three tiles", async () =>
      (await page.locator("[data-tile]").count()) === 3 ? true : undefined,
    );
    // Grouped by task: the main terminal, then the child's session as its own group.
    expect(await page.locator(".tgroup.lane .ghead .gt").allTextContents()).toEqual([
      "this repository session",
    ]);
    expect(await tile(worker).locator(".tile-band .repo-name").textContent()).toBe("this repository");
    // The main terminal says how many terminals below it ask (the child's conductor); a click goes there.
    const asks = page.getByTestId(`asks-${taskConductor}`);
    await until("the asks link", async () =>
      (await asks.textContent().catch(() => ""))?.includes("1 asks") ? true : undefined,
    );
    const flashed = async (id: string) =>
      until(`${id} to flash and hold the keyboard`, async () =>
        page.evaluate((testId) => {
          const el = document.querySelector(`[data-testid="${testId}"]`);
          return el?.classList.contains("flash") && el.contains(document.activeElement) ? true : undefined;
        }, `tile-${id}`),
      );
    await asks.click();
    await flashed(childConductor);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "terminals-all-asks.png") });
    // From another terminal, the next click goes there again: one asks.
    await tile(worker).locator(".tile-band").click();
    await asks.click();
    await flashed(childConductor);
    // "↑ parent" on the worker goes to its session's conductor.
    expect(await page.getByTestId(`parent-${worker}`).textContent()).toContain("this repository · conductor");
    await page.getByTestId(`parent-${worker}`).click();
    await flashed(childConductor);
    // Alt+click on a chip shows only that value; Alt+click on it again shows them all.
    const chip = page.getByTestId("filter-role-worker");
    await chip.click({ modifiers: ["Alt"] });
    await until("only the worker", async () =>
      (await page.locator("[data-tile]").count()) === 1 ? true : undefined,
    );
    expect(await page.getByTestId("filter-shown").textContent()).toBe("Showing 1 of 3 · 2 hidden");
    await chip.click({ modifiers: ["Alt"] });
    await until("all three again", async () =>
      (await page.locator("[data-tile]").count()) === 3 ? true : undefined,
    );
    // The same in another dimension: only what asks (both conductors: the task's asks through its child).
    await page.getByTestId("filter-state-asks").click({ modifiers: ["Alt"] });
    await until("only what asks", async () =>
      (await page.locator("[data-tile]").count()) === 2 ? true : undefined,
    );
    // A terminal the filter hides stays in the tree, dimmed; a click there shows it.
    const hiddenNode = page.getByTestId(`tree-${worker}`);
    expect(await hiddenNode.getAttribute("class")).toContain("hidden");
    await hiddenNode.click();
    await flashed(worker);
    // The filter opened just enough: every terminal shows, nothing is left to reset.
    expect(await page.locator("[data-tile]").count()).toBe(3);
    expect(await page.getByTestId("filter-reset").count()).toBe(0);
    // A terminal that appears is marked new, and a toast says where it is.
    const opened = (await (
      await fetch(`${base}/panes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: child,
          role: "gate",
          label: "gate",
          argv: ["sh", "-c", "echo gate; sleep 60"],
        }),
      })
    ).json()) as { data: { id: string } };
    const toast = page.getByTestId("fresh-toast");
    await toast.waitFor({ timeout: 20_000 });
    expect(await toast.textContent()).toContain("New terminal · gate in this repository");
    expect(await tile(opened.data.id).getAttribute("class")).toContain("fresh");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "terminals-all-new.png") });
    await toast.getByRole("button", { name: "Show" }).click();
    await flashed(opened.data.id);
    // The tree's eye: shown only while its row is hovered; it hides a terminal with every terminal
    // below it; a click on a hidden one shows it and focuses it; the task's eye hides the task.
    const eye = page.getByTestId(`eye-${childConductor}`);
    const opacity = () => eye.evaluate((e) => getComputedStyle(e).opacity);
    expect(await opacity()).toBe("0");
    await page.getByTestId(`tree-${childConductor}`).hover();
    await until("the eye on hover", async () => ((await opacity()) === "1" ? true : undefined));
    await eye.click();
    await until("the session hidden", async () =>
      (await page.locator("[data-tile]").count()) === 1 ? true : undefined,
    );
    expect(await page.getByTestId("filter-shown").textContent()).toBe("Showing 1 of 4 · 3 hidden");
    await page.getByTestId(`tree-${worker}`).click();
    await flashed(worker);
    expect(await page.locator("[data-tile]").count()).toBe(2);
    await page.getByTestId(`tree-${taskConductor}`).hover();
    await page.getByTestId(`eye-task-${task}`).click();
    await until("the task hidden", async () =>
      (await page.locator("[data-tile]").count()) === 0 ? true : undefined,
    );
    await page.getByTestId("filter-reset").click();
    await until("every terminal again", async () =>
      (await page.locator("[data-tile]").count()) === 4 ? true : undefined,
    );
    // Both sidebars fold to their narrow versions, are used folded, and stay folded after a reload.
    const area = () => page.getByTestId("all-view").evaluate((e) => e.getBoundingClientRect().width);
    const before = await area();
    await page.getByTestId("tree-fold").click();
    await until("the narrow tree", async () =>
      (await page.locator(".terminal-tree.narrow").count()) === 1 ? true : undefined,
    );
    await page.getByTestId(`tree-${worker}`).click();
    await flashed(worker);
    await page.getByTestId("side-fold").click();
    await page.getByTestId("sidebar-narrow").waitFor({ timeout: 5000 });
    expect(await page.getByTestId("sidebar-narrow").getByRole("link", { name: "Board" }).count()).toBe(1);
    // The tiles take the room (the sidebar 288 → 52 px, the tree 240 → 48 px); the window keeps both.
    await until("the tiles wider", async () => ((await area()) > before + 400 ? true : undefined));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "terminals-narrow.png") });
    await page.reload();
    await page.getByTestId("sidebar-narrow").waitFor({ timeout: 20_000 });
    await page.locator(".terminal-tree.narrow").waitFor({ timeout: 20_000 });
    await page.getByTestId("sidebar-narrow").getByRole("link", { name: "Board" }).click();
    await until("the Board", async () => (page.url().includes("#/board") ? true : undefined));
    await page.goto(app("grid/all"));
    await page.getByTestId("side-fold").click();
    await page.getByTestId("needs-count").waitFor({ timeout: 5000 });
    await page.getByTestId("tree-fold").click();
    await until("the wide tree", async () =>
      (await page.locator(".terminal-tree.narrow").count()) === 0 ? true : undefined,
    );
    for (const id of [task, child])
      await metator(
        ["run", "close", "--run", id, "--aborted", "--reason", "the test ends here"],
        repo.root,
        env,
      );
    expect(errors.filter((e) => !/Notification|favicon/.test(e))).toEqual([]);
  }, 120_000);
});
