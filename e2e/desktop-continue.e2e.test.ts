/**
 * Round 11 in the desktop app, on a real daemon with the scenario host: a paused pane, "Continue
 * task", a host's long command on a card, and an app that is reloaded, or closed and opened
 * again, mid-run. Until the daemon pauses panes and answers `POST /runs/:run/continue` itself,
 * the test lays the contract's fields over the daemon's real answers (`paused` on a pane, a
 * permission question's `command`, the continue route's result).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
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
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-continue-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-continue-config-"));
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

const LONG =
  'metator run delegate build --agent mt-implementer --card "Add src/currency.ts exporting the list of supported currencies; a failing test first in test/currency.test.ts; write build-log.md with the files changed, the test command and its result. Summary of at most 10 lines." --run ';

/** The contract's fields laid over the daemon's answers (until the engine sends them itself). */
async function fixtures(p: Page, paused: () => string | undefined, child: () => string, calls: string[]) {
  await p.route("**/layout**", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { data?: { panes?: Record<string, unknown>[] } };
    for (const pane of body.data?.panes ?? [])
      if (pane.id === paused())
        Object.assign(pane, {
          paused: { at: "2026-11-20T10:00:00.000Z", why: "daemon-stopped" },
          live: { ...(pane.live as object), alive: false },
        });
    await route.fulfill({ response: res, json: body });
  });
  await p.route("**/runs/*/continue**", async (route) => {
    calls.push(`${new URL(route.request().url()).pathname} ${route.request().postData() ?? ""}`);
    await route.fulfill({
      json: {
        ok: true,
        data: {
          resumed: [{ paneId: paused(), role: "worker", sessionId: "s1" }],
          drives: [],
          skipped: [{ runId: child(), why: "its conductor is live" }],
        },
      },
    });
  });
  // A host's permission question with its whole command: over the inbox's socket and its route.
  const withAsk = (env: { ok: boolean; data?: { decisions: unknown[] } }) => {
    if (
      env.data &&
      !env.data.decisions.some((d) => (d as { question: { id: string } }).question.id === "q900")
    )
      env.data.decisions = [
        {
          runId: child(),
          stage: "build",
          waitedMs: 1000,
          driving: false,
          task: "The price model",
          question: {
            id: "q900",
            runId: child(),
            source: "permission",
            agent: "mt-orchestrator",
            prompt: `mt-orchestrator waits for your answer in pane w1:p2: ${LONG.slice(0, 60)}`,
            command: `${LONG}${child()}`,
            options: [{ label: "Yes" }, { label: "No" }],
            askedAt: "2026-11-20T10:00:00.000Z",
          },
        },
        ...env.data.decisions,
      ];
    return env;
  };
  await p.route("**/inbox", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: withAsk(await res.json()) });
  });
  await p.routeWebSocket("**/ws/inbox**", (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => ws.send(JSON.stringify(withAsk(JSON.parse(String(m))))));
    ws.onMessage((m) => server.send(m));
  });
}

async function nameIfAsked(p: Page) {
  const who = p.getByRole("dialog", { name: "your name" });
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

describe("sessions survive, one Continue, whole commands, reloads change nothing (round 11)", () => {
  test("a paused pane, Continue task, a long command on a card, and the same app after a reload and a new window", async () => {
    const make = async (args: string[]) =>
      (
        (await metator(["run", "new", "--workflow", "demo", ...args], repo.root, env)).json.data as {
          runId: string;
        }
      ).runId;
    const task = await make(["--task", TITLE]);
    const child = await make(["--task", "The price model", "--parent", task]);
    for (const id of [task, child])
      expect((await metator(["run", "start", "--run", id], repo.root, env)).code).toBe(0);
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
    const calls: string[] = [];
    await fixtures(
      page,
      () => worker,
      () => child,
      calls,
    );

    // 1. The worker paused with the daemon: its badge counts it; its banner says why, read-only.
    await page.goto(app(`grid/task/${task}`));
    const badge = page.getByTestId(`open-session-${child}`);
    await until("the paused badge", async () =>
      (await badge.textContent().catch(() => ""))?.includes("1 sub-terminal · 1 paused") ? true : undefined,
    );
    // 2. Continue task, in the bar and on the main terminal's tile.
    const cont = page.getByTestId("continue-task");
    await cont.waitFor({ timeout: 20_000 });
    expect(await page.getByTestId(`tile-${taskConductor}`).getByTestId("continue-task-tile").count()).toBe(1);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "continue-task.png") });
    await cont.click();
    await nameIfAsked(page);
    await until("the continue notice", async () =>
      (
        await page
          .locator(".workbench .notice")
          .textContent()
          .catch(() => "")
      )?.includes("Continued: resumed 1 terminal.")
        ? true
        : undefined,
    );
    expect(await page.locator(".workbench .notice").textContent()).toContain(`Skipped 1: ${child}`);
    expect(calls[0]).toContain(`/runs/${task}/continue`);
    expect(calls[0]).toContain('"by":"ana"');
    await badge.click();
    const banner = page.getByTestId(`paused-${worker}`);
    await banner.waitFor({ timeout: 20_000 });
    expect(await banner.textContent()).toContain("Paused — the daemon stopped");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "paused-pane.png") });
    await banner.getByRole("button", { name: "Continue" }).click();
    await until("the pane's continue", async () =>
      calls.some((c) => c.includes(`/runs/${child}/continue`)) ? true : undefined,
    );

    // 3. A host's long command on Home: its start, cut; a click and Enter show it whole.
    await page.goto(app(`inbox/${child}/q900`));
    const card = page.getByRole("article", { name: "decision card" });
    const short = card.getByTestId("command-short");
    await short.waitFor({ timeout: 20_000 });
    expect((await short.textContent())?.startsWith("metator run delegate build --agent mt-implementer")).toBe(
      true,
    );
    expect((await short.textContent())?.endsWith("…")).toBe(true);
    expect(await card.locator("h1").textContent()).not.toContain("waits for your answer");
    await short.click();
    expect(await card.getByTestId("command-full").textContent()).toBe(`${LONG}${child}`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "long-command-expanded.png") });
    await short.press("Enter");
    expect(await card.getByTestId("command-full").count()).toBe(0);
    await short.press("Enter");
    expect(await card.getByTestId("command-full").count()).toBe(1);

    // 4. A reload changes nothing: the same view, the same tiles and screens, the same card.
    const look = async (p: Page) => {
      await p.goto(app(`grid/task/${task}`));
      await p.getByTestId("task-view").waitFor({ timeout: 20_000 });
      await until("the tiles", async () => ((await p.locator(".tile").count()) === 2 ? true : undefined));
      await until("the conductor's screen", async () =>
        (await p.getByTestId(`frame-${taskConductor}`).textContent())?.includes("I am the conductor")
          ? true
          : undefined,
      );
      const tiles = await p
        .locator(".tile")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      const badgeText = await until("the badge", async () => {
        const t = await p
          .getByTestId(`open-session-${child}`)
          .textContent()
          .catch(() => "");
        return t?.includes("paused") ? t : undefined;
      });
      await p.goto(app(`inbox/${child}/q900`));
      const heading = await until(
        "the card",
        async () =>
          (await p
            .getByRole("article", { name: "decision card" })
            .getByTestId("command-short")
            .textContent()
            .catch(() => "")) || undefined,
      );
      return { tiles, badgeText, heading, url: p.url().replace(/\?daemon=[^#]*/, "") };
    };
    const before = await look(page);
    expect(before.tiles).toEqual([`tile-${taskConductor}`, `tile-${childConductor}`]);
    await page.goto(app(`grid/task/${task}`));
    await page.reload();
    const again = await look(page);
    expect(again).toEqual(before);
    // The run went on untouched by the reload: its panes and their sessions are the same.
    expect((await layout()).map((p) => p.id).sort()).toEqual(panes.map((p) => p.id).sort());

    // 5. The window closed and a new one opened: the same again.
    const b = await browser();
    const fresh: BrowserContext = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const other = await fresh.newPage();
    other.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
    await fixtures(
      other,
      () => worker,
      () => child,
      calls,
    );
    expect(await look(other)).toEqual(before);
    await fresh.close();

    for (const id of [task, child])
      await metator(
        ["run", "close", "--run", id, "--aborted", "--reason", "the test ends here"],
        repo.root,
        env,
      );
    expect(errors.filter((e) => !/Notification|favicon/.test(e))).toEqual([]);
  }, 150_000);
});
