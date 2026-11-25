/**
 * Round 11 in the desktop app, on a real daemon with the scenario host: a task's conductor, a
 * child's conductor and its worker; the daemon stopped with SIGTERM and started with
 * `--no-restore`, so the panes are really paused. The app shows them paused (badge, banner, last
 * screen), the same after a reload and in a new window; a pane's own Continue resumes only it
 * (`POST /panes/:pane/continue`), "Continue task" the rest (`POST /runs/:run/continue`). The one
 * fixture: a host's permission question with a long `command` (a scenario host draws no Claude
 * Code approval), laid over the inbox to show it cut and whole on a card.
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
// Each agent's second entry is what its session says when it is resumed; it reads the line the
// daemon types into a resumed session (it is idle: no question mark) and stays, as a host does.
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-orchestrator:
    - - say: "I am the conductor of this run. I delegate the build to a worker and collect its result."
      - ask: { question: "Type here to talk to the conductor.", options: [go on] }
    - - say: "The conductor goes on where it stopped."
      - ask: { question: "Type here to talk to the conductor again.", options: [go on] }
      - run: "sleep 300"
  mt-implementer:
    - - say: "Building the step."
      - ask: { question: "Type here to talk to the worker.", options: [go on] }
    - - say: "The worker goes on where it stopped."
      - ask: { question: "Type here to talk to the worker again.", options: [go on] }
      - run: "sleep 300"
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
let daemon: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
/** The daemon's port, kept across its restart: the app's address stays the same. */
let port = 0;
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

/** `metator serve` on the kept port; `--no-restore` leaves paused panes paused. */
async function startDaemon(...extra: string[]): Promise<void> {
  const d = Bun.spawn(
    [
      "bun",
      CLI_ENTRY,
      "serve",
      "--port",
      String(port),
      "--poll-ms",
      "100",
      "--supervise-ms",
      "0",
      "--screens-ms",
      "300",
      ...extra,
    ],
    {
      cwd: repo.root,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
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
    for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return;
  })();
}

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
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  port = probe.port as number;
  probe.stop(true);
  await startDaemon();
  const b = await browser();
  page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", onPageError);
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

/**
 * The one fixture: a host's permission question with its whole command, laid over the inbox (its
 * route and its socket). A scenario host draws no Claude Code approval for the daemon to read.
 */
async function longCommandAsk(p: Page, child: () => string) {
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
            prompt: `${LONG.split(" --card")[0]} — This command requires approval`,
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

/**
 * An exception in the page is an error of the app, except one: Playwright's own script of the
 * routed `/ws/inbox` (above) throws when a message of the daemon arrives for a socket the page
 * has closed (a reload, a window that goes). The browser itself only logs a late send to the
 * console, which still counts, so a socket the app writes to after closing it is still caught.
 */
function onPageError(e: Error) {
  if (
    /^WebSocket is already in CLOSING or CLOSED state\.$/.test(e.message.trim()) &&
    !e.stack?.includes("/assets/")
  )
    return;
  errors.push(`${e.message}\n${e.stack ?? ""}`);
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
  test("really paused panes, their Continue and Continue task, a long command, the same app after a reload and in a new window", async () => {
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
    type P = {
      id: string;
      runId?: string;
      role: string;
      paused?: { why: string };
      live?: { alive: boolean };
    };
    const layout = async () =>
      ((await (await fetch(`${base}/layout`)).json()) as { data: { panes: P[] } }).data.panes;
    const screen = async (id: string) =>
      ((await (await fetch(`${base}/panes/${id}`)).json()) as { data: { text: string } }).data.text;
    const panes = await until("three live panes", async () => {
      const p = await layout();
      return p.length >= 3 && p.every((x) => x.live?.alive) ? p : undefined;
    });
    const of = (runId: string, role: string) =>
      panes.find((p) => p.runId === runId && p.role === role)?.id as string;
    const [taskConductor, childConductor, worker] = [
      of(task, "conductor"),
      of(child, "conductor"),
      of(child, "worker"),
    ];
    await until("the worker's screen", async () =>
      (await screen(worker)).includes("Building the step") ? true : undefined,
    );
    // The screens are kept on disk every 300 ms; then the daemon stops (SIGTERM) and starts with
    // --no-restore: every pane is paused, really.
    await Bun.sleep(800);
    daemon?.kill("SIGTERM");
    await daemon?.exited;
    stopProcessesUnder(repo.root);
    await startDaemon("--no-restore");
    await until("every pane paused", async () => {
      const p = await layout();
      return p.length === 3 && p.every((x) => x.paused?.why === "daemon-stopped") ? true : undefined;
    });
    await longCommandAsk(page, () => child);

    // What the person sees, read the same way in each window: the task's view and Home's card.
    const look = async (p: Page) => {
      await p.goto(app(`grid/task/${task}`));
      await p.getByTestId("task-view").waitFor({ timeout: 20_000 });
      await until("the tiles", async () => ((await p.locator(".tile").count()) === 2 ? true : undefined));
      // A paused pane keeps its last screen, read-only, under its banner.
      await until("the conductor's last screen", async () =>
        (await p.getByTestId(`frame-${taskConductor}`).textContent())?.includes("I am the conductor")
          ? true
          : undefined,
      );
      const tiles = await p
        .locator(".tile")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      const banners = await p.locator('[data-testid^="paused-"]').count();
      const badgeText = await until("the badge", async () => {
        const t = await p
          .getByTestId(`open-session-${child}`)
          .textContent()
          .catch(() => "");
        return t?.includes("paused") ? t : undefined;
      });
      const offered = await p.getByTestId("continue-task").count();
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
      return { tiles, banners, badgeText, offered, heading };
    };

    // 1. Paused: the session's badge counts its paused worker; every tile has its banner.
    const before = await look(page);
    expect(before).toEqual({
      tiles: [`tile-${taskConductor}`, `tile-${childConductor}`],
      banners: 2,
      badgeText: "1 sub-terminal · 1 paused ›",
      offered: 1,
      heading: expect.stringMatching(/^metator run delegate build --agent mt-implementer .*…$/),
    });

    // 3. The long command: cut on the card, whole on a click and on Enter.
    const card = page.getByRole("article", { name: "decision card" });
    const short = card.getByTestId("command-short");
    expect(await card.locator("h1").textContent()).not.toContain("This command requires approval");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "long-command-collapsed.png") });
    await short.click();
    expect(await card.getByTestId("command-full").textContent()).toBe(`${LONG}${child}`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "long-command-expanded.png") });
    await short.press("Enter");
    expect(await card.getByTestId("command-full").count()).toBe(0);

    // 4. A reload changes nothing; nor does a new window. The panes are the same and still paused.
    await page.reload();
    expect(await look(page)).toEqual(before);
    const b = await browser();
    const fresh: BrowserContext = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const other = await fresh.newPage();
    other.on("pageerror", onPageError);
    await longCommandAsk(other, () => child);
    expect(await look(other)).toEqual(before);
    await fresh.close();
    expect((await layout()).every((x) => x.paused)).toBe(true);

    // 1. A pane's own Continue resumes only that pane, its session in place.
    await page.goto(app(`grid/task/${task}/${child}`));
    const banner = page.getByTestId(`paused-${worker}`);
    await banner.waitFor({ timeout: 20_000 });
    expect(await banner.textContent()).toContain("Paused — the daemon stopped");
    // Its last screen is there, read-only, under the banner.
    await until("the worker's last screen", async () => {
      if ((await page.getByTestId(`frame-${worker}`).textContent())?.includes("Building the step"))
        return true;
      return undefined;
    }).catch(async (e) => {
      throw new Error(`${(e as Error).message}; the daemon serves: ${JSON.stringify(await screen(worker))}`);
    });
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "paused-pane.png") });
    await banner.getByRole("button", { name: "Continue" }).click();
    await nameIfAsked(page);
    await until("the worker resumed", async () => {
      const w = (await layout()).find((x) => x.id === worker);
      return w && !w.paused && w.live?.alive ? true : undefined;
    });
    expect(
      (await layout())
        .filter((x) => x.paused)
        .map((x) => x.id)
        .sort(),
    ).toEqual([taskConductor, childConductor].sort());
    await until("the worker going on", async () =>
      (await page.getByTestId(`frame-${worker}`).textContent())?.includes(
        "The worker goes on where it stopped",
      )
        ? true
        : undefined,
    );
    await until("its banner gone", async () =>
      (await page.getByTestId(`paused-${worker}`).count()) === 0 ? true : undefined,
    );

    // 2. Continue task resumes the rest, across the task's runs, and says what it did.
    await page.getByTestId("terminals-task").click();
    const cont = page.getByTestId("continue-task");
    await cont.click();
    await nameIfAsked(page);
    const said = await until("the continue notice", async () => {
      const t = await page
        .locator(".workbench .notice")
        .textContent()
        .catch(() => "");
      return t?.includes("Continued:") ? t : undefined;
    });
    expect(said).toContain("resumed 2 terminals");
    await until("every pane live", async () =>
      (await layout()).every((x) => !x.paused && x.live?.alive) ? true : undefined,
    );
    await until("Continue task gone", async () => ((await cont.count()) === 0 ? true : undefined));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "continue-task.png") });
    await until("the conductor going on", async () =>
      (await page.getByTestId(`frame-${taskConductor}`).textContent())?.includes(
        "The conductor goes on where it stopped",
      )
        ? true
        : undefined,
    );

    for (const id of [task, child])
      await metator(
        ["run", "close", "--run", id, "--aborted", "--reason", "the test ends here"],
        repo.root,
        env,
      );
    expect(errors.filter((e) => !/Notification|favicon/.test(e))).toEqual([]);
  }, 180_000);
});
