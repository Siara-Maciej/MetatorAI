/**
 * The desktop app against a daemon that is not there, that has no AI host, whose host dies at
 * once, that is restarted, and that serves a folder of repositories: the built app in a real
 * Chromium, the real `metator serve` started and stopped by the test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
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
/** A run of this workflow escalates at once: its only stage is a gate that fails until a file exists. */
const STUCK = `kind: Workflow
schemaVersion: 2
id: stuck
stages:
  - id: check
    gate: { script: "test -f {runDir}/fixed" }
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
const NOWHERE = {
  METATOR_COPILOT_BIN: "/nonexistent/copilot",
  METATOR_CLAUDE_BIN: "/nonexistent/claude",
  METATOR_OPENCODE_BIN: "/nonexistent/opencode",
};

let repo: ScratchRepo;
let folder: string;
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
let daemon: Bun.Subprocess | undefined;
let port = 0;
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
const base = () => `http://127.0.0.1:${port}`;
const app = (hash: string) => `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(base())}#/${hash}`;
const api = async (path: string) =>
  (await fetch(`${base()}${path}`)).json() as Promise<{ ok: boolean; data: Record<string, unknown> }>;

/** The daemon on the test's port, in a directory, with the hosts the environment names. */
async function serve(cwd: string, env: Record<string, string>): Promise<void> {
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", String(port), "--poll-ms", "100", "--supervise-ms", "0"],
    {
      cwd,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, METATOR_CONFIG_DIR: configDir, ...env },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await until("the daemon to answer", async () => {
    try {
      return (await fetch(`${base()}/state`)).ok ? true : undefined;
    } catch {
      return undefined;
    }
  });
}
async function stop(): Promise<void> {
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  daemon = undefined;
}

beforeAll(async () => {
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
  // A port nothing listens on yet: the app is opened before the daemon exists.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  port = probe.port as number;
  await probe.stop(true);
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-config-"));
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write(".github/metator/workflows/stuck.yml", STUCK);
  await repo.write("scenario.yml", SCENARIO);
  // A host that is installed but cannot work: it says why and exits.
  await repo.write("bin/claude", '#!/bin/sh\necho "claude: not logged in"\nexit 3\n');
  chmodSync(repo.path("bin/claude"), 0o755);
  await repo.commit("init");
  // A folder of two repositories, each with the workflow.
  folder = await mkdtemp(join(tmpdir(), "metator-desktop-folder-"));
  for (const name of ["alpha", "beta"]) {
    const dir = join(folder, name);
    await mkdir(join(dir, ".github/metator/workflows"), { recursive: true });
    await Bun.write(join(dir, ".github/metator/workflows/demo.yml"), WORKFLOW);
    await Bun.write(join(dir, ".gitignore"), ".metator/\n");
    await Bun.write(join(dir, "a.ts"), `export const ${name} = 1;\n`);
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "-A"],
      [
        "-c",
        "user.email=e2e@example.com",
        "-c",
        "user.name=E2E",
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
  const b = await browser();
  page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
}, 120_000);

afterAll(async () => {
  await closeBrowser();
  await stop();
  site.stop(true);
  await repo.dispose();
  await rm(folder, { recursive: true, force: true });
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("MetatorAI Desktop and the daemon's own troubles (real daemon, real Chromium)", () => {
  test("with no daemon every screen is one panel that says what to do; it goes when the daemon comes (D3)", async () => {
    await page.goto(app("inbox"));
    const panel = page.getByTestId("no-daemon");
    await panel.waitFor({ timeout: 20_000 });
    const text = (await panel.textContent()) ?? "";
    expect(text).toContain("The daemon is not running");
    expect(text).toContain(`nothing answers at ${base()}`);
    expect(text).toContain("metator serve");
    expect(await panel.getByLabel("daemon address").inputValue()).toBe(base());
    expect(await page.getByTestId("connection").textContent()).toBe("no daemon");
    // Nothing claims an empty inbox, and nothing can be started.
    expect(await page.locator("main.content").textContent()).not.toContain("Inbox zero");
    expect(await page.getByRole("button", { name: "+ New session" }).isDisabled()).toBe(true);
    for (const screen of ["grid", "backlog", "mrs", "settings", "supervisor", "session/nope"]) {
      await page.goto(app(screen));
      await panel.waitFor({ timeout: 10_000 });
    }
    await page.goto(app("inbox"));
    await serve(repo.root, NOWHERE);
    await panel.getByRole("button", { name: "Retry" }).click();
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    expect(await panel.count()).toBe(0);
    expect(await page.locator("main.content").textContent()).toContain("Inbox zero");
  }, 90_000);

  test("with no AI host installed + New session says so and opens nothing; the form offers no host (D1)", async () => {
    await page.getByRole("button", { name: "+ New session" }).click();
    const notice = page.locator("main.content > .notice");
    await notice.waitFor({ timeout: 20_000 });
    const said = (await notice.textContent()) ?? "";
    expect(said).toContain("No AI host is installed");
    expect(said).toContain("/nonexistent/copilot, /nonexistent/claude and /nonexistent/opencode");
    expect(said).toContain('the guide page "Copilot and Claude Code", site/guide/hosts.md');
    expect(page.url()).toContain("#/inbox");
    expect(((await api("/layout")).data.panes as unknown[]).length).toBe(0);
    await page.getByRole("button", { name: "Advanced…" }).click();
    const dialog = page.getByRole("dialog", { name: "new session" });
    await dialog.getByTestId("no-host").waitFor({ timeout: 20_000 });
    expect(await dialog.getByLabel("Host").inputValue()).toBe("");
    expect(await dialog.getByLabel("Host").locator("option:disabled").allTextContents()).toEqual([
      "copilot (not installed)",
      "claude (not installed)",
      "opencode (not installed)",
    ]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.goto(app("supervisor"));
    await page.getByTestId("host-claude").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("host-claude").textContent()).toContain("not installed");
  }, 60_000);

  test("a pane whose process exited shows its last output and exit code, with Retry and Close tab (D1)", async () => {
    await stop();
    await page.getByTestId("no-daemon").waitFor({ timeout: 20_000 });
    await serve(repo.root, { ...NOWHERE, METATOR_CLAUDE_BIN: repo.path("bin/claude") });
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    await page.goto(app("inbox"));
    await page.getByRole("button", { name: "+ New session" }).click();
    // The first host of the order (copilot) is not installed: the session starts on the one that is.
    const ended = page.locator('[data-testid^="ended-"]');
    await ended.waitFor({ timeout: 20_000 });
    const panes = (await api("/layout")).data.panes as { id: string; process: { host: string } }[];
    expect(panes.map((p) => p.process.host)).toEqual(["claude"]);
    expect(await ended.textContent()).toContain("The process ended with code 3.");
    await until("the last output", async () =>
      (await page.locator(".pane-frame").first().textContent())?.includes("claude: not logged in")
        ? true
        : undefined,
    );
    // Retry starts the same program in a new pane and drops the dead one: still one pane.
    await ended.getByRole("button", { name: "Retry" }).click();
    await until("the retried pane", async () => {
      const now = (await api("/layout")).data.panes as { id: string }[];
      return now.length === 1 && now[0]?.id !== panes[0]?.id ? true : undefined;
    });
    await ended.waitFor({ timeout: 20_000 });
    await ended.getByRole("button", { name: "Close tab" }).click();
    await until("the tab gone", async () =>
      ((await api("/layout")).data.panes as unknown[]).length === 0 ? true : undefined,
    );
    await until("no dead pane on the screen", async () => ((await ended.count()) === 0 ? true : undefined));
  }, 90_000);

  test("a terminal comes back by itself after the daemon was restarted (D4)", async () => {
    await stop();
    await serve(repo.root, { ...NOWHERE, METATOR_AGENT_SCENARIO: repo.path("scenario.yml") });
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    const created = await metator(
      ["run", "init", "--workflow", "demo", "--task", "Round the totals"],
      repo.root,
    );
    const runId = (created.json.data as { runId: string }).runId;
    await page.goto(app(`session/${runId}`));
    const term = page.getByTestId(`terminal-${runId}`);
    await term.waitFor({ timeout: 20_000 });
    await until("the session to greet", async () =>
      (await term.textContent())?.includes("hello from the session") ? true : undefined,
    );
    await stop();
    await page.getByTestId("no-daemon").waitFor({ timeout: 20_000 });
    await serve(repo.root, { ...NOWHERE, METATOR_AGENT_SCENARIO: repo.path("scenario.yml") });
    // No reload and no navigation: the same page shows the session's terminal again.
    await term.waitFor({ timeout: 30_000 });
    await until("the terminal after the restart", async () =>
      (await term.textContent())?.includes("hello from the session") ? true : undefined,
    );
    expect(await page.getByTestId("connection").textContent()).toBe("connected");
  }, 120_000);

  test("an escalated run is a card in the Inbox with why it stopped; Resume drives it on, Close ends it (F1, D9)", async () => {
    // The daemon's drives use the scenario host: no real AI host is ever started.
    const scenario = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml"), METATOR_HOST: "scenario" };
    await stop();
    await serve(repo.root, { ...NOWHERE, ...scenario });
    const cli = (...args: string[]) => metator(args, repo.root, scenario);
    const escalate = async (task: string) => {
      const runId = (
        (await cli("run", "init", "--workflow", "stuck", "--task", task)).json.data as { runId: string }
      ).runId;
      const driven = await cli("run", "drive", "--run", runId, "--host", "scenario");
      expect((driven.json.data as { status: string }).status).toBe("escalated");
      return runId;
    };
    const statusOf = async (runId: string) =>
      ((await cli("run", "status", "--run", runId)).json.data as { status: string }).status;
    const runId = await escalate("Check the totals");
    await page.goto(app("inbox"));
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    // It is listed among what needs the person, and in the sessions panel, not under "finished".
    const row = page.getByTestId(`escalated-${runId}`);
    await row.waitFor({ timeout: 20_000 });
    expect(await page.locator("aside.sessions .list").textContent()).toContain("Check the totals");
    expect(await page.locator("main.content").textContent()).not.toContain("Inbox zero");
    await row.click();
    const card = page.getByTestId("escalated-card");
    await card.waitFor({ timeout: 20_000 });
    expect(await card.getByTestId("escalated-reason").textContent()).toContain(
      "gate `test -f {runDir}/fixed`",
    );
    // The cause removed, then Resume: the app asks who, the daemon resumes the run and drives it.
    await Bun.write(repo.path(`.metator/runs/${runId}/fixed`), "");
    await card.getByRole("button", { name: "Resume" }).click();
    const who = page.getByRole("dialog", { name: "your name" });
    await who.waitFor({ timeout: 5000 });
    await who.getByLabel("Your name").fill("maciej");
    await who.getByRole("button", { name: "Save" }).click();
    await until("the resumed run to finish", async () =>
      (await statusOf(runId)) === "done" ? true : undefined,
    );
    await until("its row to go", async () => ((await row.count()) === 0 ? true : undefined));
    const log = await repo.read(`.metator/runs/${runId}/log.md`);
    expect(log).toContain("resumed at check · by maciej");

    // Another one is closed from its card: a reason is required, and the run ends as aborted.
    const other = await escalate("Check the taxes");
    await page.getByTestId(`escalated-${other}`).click();
    await card.getByRole("button", { name: "Close run…" }).click();
    const close = card.getByRole("button", { name: "Close as aborted" });
    expect(await close.isDisabled()).toBe(true);
    await card.getByLabel("why the run is closed (required)").fill("not worth fixing");
    await close.click();
    await until("the run to be aborted", async () =>
      (await statusOf(other)) === "aborted" ? true : undefined,
    );
    await until("its row to go", async () =>
      (await page.getByTestId(`escalated-${other}`).count()) === 0 ? true : undefined,
    );
    expect(errors).toEqual([]);
  }, 120_000);

  test("in a folder a run's screens use the run's repository and the list screens the chosen one (D10)", async () => {
    await stop();
    await serve(folder, NOWHERE);
    await page.goto(app("backlog"));
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    const created = (await (
      await fetch(`${base()}/runs?repo=beta`, {
        method: "POST",
        body: JSON.stringify({ workflow: "demo", task: "Beta task" }),
      })
    ).json()) as { data: { run: { runId: string } } };
    const runId = created.data.run.runId;
    await Bun.write(join(folder, "beta", "b.ts"), "export const b = 2;\n");
    await metator(["issue", "add", "Beta issue", "--by", "maciej"], join(folder, "beta"));
    // The change of a run of the second repository is read in that repository.
    await page.goto(app(`review/${runId}`));
    await page.getByTestId("file-b.ts").waitFor({ timeout: 20_000 });
    // The backlog starts on the first repository; the select moves it, and the choice is kept.
    await page.goto(app("backlog"));
    const select = page.getByLabel("repository");
    await select.waitFor({ timeout: 20_000 });
    expect(await select.inputValue()).toBe("alpha");
    expect(await page.getByTestId("issue-i001").count()).toBe(0);
    await select.selectOption("beta");
    await page.getByTestId("issue-i001").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("issue-i001").textContent()).toContain("Beta issue");
    for (const screen of ["grid", "mrs", "settings", "supervisor"]) {
      await page.goto(app(screen));
      await page.getByLabel("repository").waitFor({ timeout: 20_000 });
      expect(await page.getByLabel("repository").inputValue()).toBe("beta");
    }
    await page.reload();
    await page.getByLabel("repository").waitFor({ timeout: 20_000 });
    expect(await page.getByLabel("repository").inputValue()).toBe("beta");
    expect(errors).toEqual([]);
  }, 120_000);
});
