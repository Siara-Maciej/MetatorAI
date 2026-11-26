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
import { browser, closeBrowser, decisionOnHome } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
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
/** Escalates at its second stage: a resume may go back to the first. */
const STUCK_LATE = `kind: Workflow
schemaVersion: 2
id: stuck-late
stages:
  - id: prepare
    gate: { script: "true" }
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
  await repo.write(".github/metator/workflows/stuck-late.yml", STUCK_LATE);
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
  // A drive or a pane the daemon started works in the repository or the folder: nothing outlives the test.
  stopProcessesUnder(repo.root);
  stopProcessesUnder(folder);
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
    expect(await page.locator("main.content").textContent()).not.toContain("Nothing waits for you");
    expect(await page.getByRole("button", { name: "+ New chat" }).isDisabled()).toBe(true);
    for (const screen of ["grid", "backlog", "mrs", "settings", "supervisor", "session/nope"]) {
      await page.goto(app(screen));
      await panel.waitFor({ timeout: 10_000 });
    }
    await page.goto(app("inbox"));
    await serve(repo.root, NOWHERE);
    await panel.getByRole("button", { name: "Retry" }).click();
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    expect(await panel.count()).toBe(0);
    expect(await page.locator("main.content").textContent()).toContain("Describe a task");
  }, 90_000);

  test("in the app's shell the daemon starts itself: for the open repository, or the one the person picks (ADR-0101, ADR-0105)", async () => {
    await stop();
    const fresh = await ScratchRepo.create();
    await fresh.write(".gitignore", ".metator/\n");
    await fresh.commit("init");
    const started: number[] = [];
    const b = await browser();
    // The shell's commands through Tauri's own `invoke`: `open_repo` done by the real CLI, as the
    // Tauri window runs it; the app knows two repositories, the first of which does not exist.
    const shell = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await shell.exposeFunction("ensureDaemonForTest", async (dir: string) => {
      const r = await metator(["-C", dir, "serve", "--ensure", "--port", "0"], dir, {
        METATOR_CONFIG_DIR: configDir,
      });
      if (r.code !== 0) throw new Error((r.json.error as { message: string }).message);
      const data = r.json.data as { url: string; pid: number };
      started.push(data.pid);
      return data.url;
    });
    await shell.addInitScript((freshRoot: string) => {
      const w = window as unknown as {
        __TAURI__: unknown;
        ensureDaemonForTest(dir: string): Promise<string>;
      };
      const known = [
        { path: "/nowhere/at/all", name: "all", kind: "repo", addedAt: "2026-01-01T00:00:00Z" },
        { path: freshRoot, name: "fresh", kind: "repo", addedAt: "2026-01-02T00:00:00Z" },
      ];
      w.__TAURI__ = {
        core: {
          invoke: async (cmd: string, args: { path: string }) => {
            if (cmd === "known_repos") return known;
            if (cmd === "open_repo") {
              try {
                return { url: await w.ensureDaemonForTest(args.path) };
              } catch (e) {
                throw { code: "COMMAND_FAILED", message: (e as Error).message };
              }
            }
            throw { code: "USAGE", message: `not in this test: ${cmd}` };
          },
        },
      };
    }, fresh.root);
    try {
      // First start: nothing remembered, so the first repository the app knows is opened. It does
      // not exist: the panel says why, and the switcher offers the others.
      await shell.goto(app("inbox"));
      const panel = shell.getByTestId("no-daemon");
      await panel.getByTestId("start-error").waitFor({ timeout: 30_000 });
      expect(await panel.textContent()).not.toContain("In a terminal");
      await shell.getByTestId("scope").click();
      await shell
        .getByRole("menu", { name: "repositories" })
        .getByRole("menuitem", { name: "fresh" })
        .click();
      await shell.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 40_000 });
      expect(await panel.count()).toBe(0);
      expect(started).toHaveLength(1);
      expect((await shell.getByTestId("scope").textContent())?.startsWith("fresh")).toBe(true);

      // The daemon goes away while the app is open: the app starts one again for the same folder,
      // with nothing typed and nothing clicked.
      process.kill(started[0] as number, "SIGTERM");
      await until("a second daemon", async () => (new Set(started).size > 1 ? true : undefined), 60_000);
      await shell.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 40_000 });

      // The app is opened again (its address still names the old port): the remembered folder's
      // daemon is found, not started a third time.
      await shell.goto(app("inbox"));
      await shell.reload();
      await shell.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 40_000 });
      expect(new Set(started).size).toBe(2);
    } finally {
      await shell.close();
      for (const pid of started) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      await fresh.dispose();
      // The next tests look at the daemon of the shared repository again.
      await serve(repo.root, NOWHERE);
    }
  }, 180_000);

  test("with no AI host installed + New chat says so and opens nothing; the form offers no host (D1)", async () => {
    await page.getByRole("button", { name: "+ New chat" }).click();
    const notice = page.locator("main.content > .notice");
    await notice.waitFor({ timeout: 20_000 });
    const said = (await notice.textContent()) ?? "";
    expect(said).toContain("No AI host is installed");
    expect(said).toContain("/nonexistent/copilot, /nonexistent/claude and /nonexistent/opencode");
    expect(said).toContain('the guide page "Copilot and Claude Code", site/guide/hosts.md');
    expect(page.url()).toContain("#/inbox");
    expect(((await api("/layout")).data.panes as unknown[]).length).toBe(0);
    await page.getByRole("button", { name: "New run from the form" }).click();
    const dialog = page.getByRole("dialog", { name: "new run" });
    await dialog.getByTestId("no-host").waitFor({ timeout: 20_000 });
    expect(await dialog.getByLabel("AI host").inputValue()).toBe("");
    expect(await dialog.getByLabel("AI host").locator("option:disabled").allTextContents()).toEqual([
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
    await page.getByRole("button", { name: "+ New chat" }).click();
    // A new chat is a person's act: the app asks for the name once.
    const named = page.getByRole("dialog", { name: "your name" });
    await named.waitFor({ timeout: 5000 });
    await named.getByLabel("Your name").fill("maciej");
    await named.getByRole("button", { name: "Save" }).click();
    // The chat's page shows its pane; Retry and Close of a pane are in Terminals.
    await until("the chat's page", async () => (page.url().includes("#/thread/") ? true : undefined));
    await page.goto(app("grid"));
    // The first host of the order (copilot) is not installed: the session starts on the one that is.
    const ended = page.locator('[data-testid^="ended-"]');
    await ended.waitFor({ timeout: 20_000 });
    const panes = (await api("/layout")).data.panes as { id: string; process: { host: string } }[];
    expect(panes.map((p) => p.process.host)).toEqual(["claude"]);
    // The pane stays with what ended it, in the error tone, with Retry and Close.
    expect(await ended.textContent()).toContain("Ended with code 3");
    await until("the last output", async () =>
      (await page.locator(".pane-frame").first().textContent())?.includes("claude: not logged in")
        ? true
        : undefined,
    );
    // Retry starts the same program in a new pane and drops the dead one: still one pane, and at
    // no moment two dead panes on the screen (the daemon opens the new one before it closes the old).
    await page.evaluate(() => {
      const w = window as unknown as { mostEnded: number; endedWatch: MutationObserver };
      const count = () => document.querySelectorAll('[data-testid^="ended-"]').length;
      w.mostEnded = count();
      w.endedWatch = new MutationObserver(() => {
        w.mostEnded = Math.max(w.mostEnded, count());
      });
      w.endedWatch.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
    // The close of the old pane is held back: what a loaded machine does, long enough to see.
    const slowClose = /\/panes\/[^/]+\/close/;
    await page.route(slowClose, async (route) => {
      await Bun.sleep(1500);
      await route.continue();
    });
    await ended.getByRole("button", { name: "Retry" }).click();
    await until("the retried pane", async () => {
      const now = (await api("/layout")).data.panes as { id: string }[];
      return now.length === 1 && now[0]?.id !== panes[0]?.id ? true : undefined;
    });
    await ended.waitFor({ timeout: 20_000 });
    await until("the new pane's own notice", async () =>
      (await ended.getAttribute("data-testid")) !== `ended-${panes[0]?.id}` ? true : undefined,
    );
    expect(
      await page.evaluate(() => {
        const w = window as unknown as { mostEnded: number; endedWatch: MutationObserver };
        w.endedWatch.disconnect();
        return w.mostEnded;
      }),
    ).toBe(1);
    await page.unroute(slowClose);
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
    await page.getByRole("button", { name: "Open a session" }).click();
    // Starting a run's agent is a person's act: the name was given once, for the chat, and is kept.
    expect(await page.getByRole("dialog", { name: "your name" }).count()).toBe(0);
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
    const escalate = async (task: string, workflow = "stuck") => {
      const runId = (
        (await cli("run", "init", "--workflow", workflow, "--task", task)).json.data as { runId: string }
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
    // It is among what needs the person on Home, and in the sidebar, not under "finished",
    // where it reads blocked: one of the first level's four words.
    const row = page.getByTestId(`escalated-${runId}`);
    await decisionOnHome(page, ["Check the totals", "Why it stopped"]);
    await row.waitFor({ timeout: 20_000 });
    const side = page.locator("aside.sessions .list .row", { hasText: "Check the totals" }).first();
    expect(await side.locator(".word").textContent()).toBe("blocked");
    expect(await page.locator("main.content").textContent()).not.toContain("Nothing waits for you");
    // One count everywhere: Home's queue and the sidebar's heading.
    const needYou = Number(/(\d+) waiting/.exec((await page.getByTestId("queue").textContent()) ?? "")?.[1]);
    expect(needYou).toBeGreaterThan(0);
    expect(await page.getByTestId("needs-count").textContent()).toContain(`Needs you · ${needYou}`);
    await page.goto(app("supervisor"));
    await until("the escalated run on the daemon screen", async () =>
      (await page.locator(".fleet").textContent())?.includes("Check the totals") ? true : undefined,
    );
    // Its session screen has no driver to show: why it stopped, Resume and Close, and no Attach;
    // nothing "waits for you here", and coming here started no session.
    await page.goto(app(`session/${runId}`));
    const bar = page.getByTestId("driverbar");
    await bar.waitFor({ timeout: 20_000 });
    expect(await bar.textContent()).toContain("Escalated at check");
    expect(await bar.textContent()).not.toContain("Working:");
    expect(await bar.getByTestId("escalated-reason").textContent()).toContain("gate `test -f ");
    expect(await bar.getByRole("button", { name: "Resume" }).count()).toBe(1);
    expect(await bar.getByRole("button", { name: "Close run…" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: /^Attach/ }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Open a session" }).count()).toBe(0);
    expect(await page.locator(".session .side").textContent()).not.toContain("nothing waits for you here");
    expect(
      ((await api("/layout")).data.panes as { runId?: string }[]).filter((p) => p.runId === runId),
    ).toEqual([]);
    await page.goto(app("inbox"));
    await decisionOnHome(page, ["Check the totals", "Why it stopped"]);
    const card = page.getByTestId("escalated-card");
    await card.waitFor({ timeout: 20_000 });
    expect(await card.getByTestId("escalated-reason").textContent()).toContain("gate `test -f ");
    // The cause removed, then Resume: the app asks who, the daemon resumes the run and drives it.
    await Bun.write(repo.path(`.metator/runs/${runId}/fixed`), "");
    await card.getByRole("button", { name: "Resume" }).click();
    // The name was given when a session was opened earlier: the app does not ask again.
    await until("the resumed run to finish", async () =>
      (await statusOf(runId)) === "done" ? true : undefined,
    );
    await until("its row to go", async () => ((await row.count()) === 0 ? true : undefined));
    const log = await repo.read(`.metator/runs/${runId}/log.md`);
    expect(log).toContain("resumed at check · by maciej");

    // Another one is closed from its card: a reason is required, and the run ends as aborted.
    const other = await escalate("Check the taxes");
    await decisionOnHome(page, ["Check the taxes", "Why it stopped"]);
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

    // Back to an earlier stage with a note: the card offers the stages the run worked, the one it
    // stopped at first, and says what the resume will do.
    const late = await escalate("Check the rounding", "stuck-late");
    await decisionOnHome(page, ["Check the rounding", "Why it stopped"]);
    const stage = card.getByLabel("stage to resume at");
    expect([await stage.inputValue(), await stage.locator("option").allTextContents()]).toEqual([
      "check",
      ["prepare", "check (where it stopped)"],
    ]);
    expect(await card.getByTestId("resume-plan").textContent()).toContain("goes back to check with a fresh");
    await stage.selectOption("prepare");
    expect(await card.getByTestId("resume-plan").textContent()).toBe(
      "the run goes back to prepare and works from there to check again; approvals on the way are asked again",
    );
    await card.getByLabel("note for the agent that works next").fill("prepare the totals first");
    await Bun.write(repo.path(`.metator/runs/${late}/fixed`), "");
    await card.getByRole("button", { name: "Resume" }).click();
    await until("the run sent back to finish", async () =>
      (await statusOf(late)) === "done" ? true : undefined,
    );
    expect(await repo.read(`.metator/runs/${late}/log.md`)).toContain(
      "resumed at prepare (escalated at check) · by maciej · note: prepare the totals first",
    );
    // The plan on the step's Overview keeps the resume and what the person said.
    await page.goto(app(`run/${late}/overview`));
    const resumes = page.getByLabel("resumes");
    await resumes.waitFor({ timeout: 20_000 });
    expect(await resumes.textContent()).toContain(
      "at prepare (escalated at check) by maciej: prepare the totals first",
    );
    expect(errors).toEqual([]);
  }, 120_000);

  test("a start refused for uncommitted changes offers Start from the last commit, in the form and the Backlog (F3)", async () => {
    // The daemon of the test before: scenario hosts only. A tracked file is changed and not committed.
    const scenario = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml"), METATOR_HOST: "scenario" };
    await repo.write("scenario.yml", `${SCENARIO}# changed, not committed\n`);
    const runsNow = async () =>
      ((await api("/state")).data.runs as { runId: string; task: string; worktree?: { path: string } }[]) ??
      [];
    const dialog = page.getByRole("dialog", { name: "new run" });
    try {
      await page.goto(app("inbox"));
      await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
      await page.getByRole("button", { name: "New run from the form" }).click();
      await dialog.getByLabel("Workflow", { exact: true }).selectOption("demo");
      await dialog.getByLabel("Task").fill("Start from a dirty tree");
      await dialog.getByLabel("AI host").selectOption("scenario");
      await dialog.getByRole("button", { name: "Create in background" }).click();
      const notice = dialog.locator(".notice");
      await notice.waitFor({ timeout: 20_000 });
      expect(await notice.textContent()).toContain(
        "the run would start without your changes: 1 tracked file(s)",
      );
      expect((await runsNow()).some((r) => r.task === "Start from a dirty tree")).toBe(false);
      await notice.getByRole("button", { name: "Start from the last commit" }).click();
      const run = await until("the run from the form", async () =>
        (await runsNow()).find((r) => r.task === "Start from a dirty tree"),
      );
      // It works in a worktree at the last commit: the uncommitted line is not there.
      expect(await repo.read(`${run.worktree?.path}/scenario.yml`)).toBe(SCENARIO);

      // The Backlog: the same refusal, the same button, and the issue's run starts.
      await metator(["issue", "add", "Tidy the totals", "--by", "maciej"], repo.root, scenario);
      await page.goto(app("backlog"));
      await page.getByTestId("issue-i001").click();
      await page.getByRole("button", { name: "Implement", exact: true }).click();
      const refused = page.locator(".backlog .notice");
      await refused.waitFor({ timeout: 20_000 });
      expect(await refused.textContent()).toContain("the run would start without your changes");
      await refused.getByRole("button", { name: "Start from the last commit" }).click();
      const issueRun = await until("the issue's run", async () =>
        (await runsNow()).find((r) => r.task.startsWith("Tidy the totals")),
      );
      expect(issueRun.worktree?.path).toBeDefined();
      for (const r of await runsNow())
        await metator(
          ["run", "close", "--run", r.runId, "--aborted", "--reason", "the test ends it"],
          repo.root,
          scenario,
        );
    } finally {
      await repo.write("scenario.yml", SCENARIO);
      // What this test opened is closed, whatever happened: the next test starts on a bare screen.
      if (await dialog.count()) await dialog.getByRole("button", { name: "Cancel" }).click();
    }
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

  test("a failed read is not an empty list, stale data says so, a stopped daemon is not answering, an unknown id is not found", async () => {
    // The daemon's answer replaced by a proxy's: a 500 whose body is text, not the envelope.
    const broken = (r: import("playwright").Route) =>
      r.fulfill({
        status: 500,
        contentType: "text/plain",
        headers: { "access-control-allow-origin": "*" },
        body: "Internal Server Error",
      });
    const line = page.getByTestId("freshness");
    const list = page.getByRole("complementary", { name: "tasks", exact: true });
    await page.route(/\/issues(\?|$)/, broken);
    try {
      await page.goto(app("backlog"));
      await line.filter({ hasText: "could not be read" }).waitFor({ timeout: 20_000 });
      expect(await line.textContent()).toContain(
        "The tasks could not be read: the daemon answered 500 on /issues (Internal Server Error)",
      );
      expect(await line.textContent()).not.toContain("JSON");
      // Nothing claims the Backlog is empty: the daemon never said so.
      expect(await list.textContent()).not.toContain("Nothing open");
      expect(await page.getByTestId("backlog").textContent()).not.toContain("No task");
      await page.unroute(/\/issues(\?|$)/, broken);
      await line.getByRole("button", { name: "Try again" }).click();
      await page.getByTestId("issue-i001").waitFor({ timeout: 20_000 });
      expect(await line.count()).toBe(0);
      // The reads after a good one fail: the list stays, the line says since when it is not current.
      await page.route(/\/issues(\?|$)/, broken);
      await line.filter({ hasText: "Not up to date: no answer since" }).waitFor({ timeout: 20_000 });
      expect(await line.getAttribute("data-state")).toBe("stale");
      expect(await page.getByTestId("issue-i001").count()).toBe(1);
    } finally {
      await page.unroute(/\/issues(\?|$)/, broken);
    }
    await line.waitFor({ state: "detached", timeout: 20_000 });

    // The new-run form whose workflows cannot be read says so and creates nothing.
    await page.route(/\/workflows(\?|$)/, broken);
    const dialog = page.getByRole("dialog", { name: "new run" });
    try {
      await page.goto(app("inbox"));
      await page.getByRole("button", { name: "New run from the form" }).click();
      const notice = dialog.locator(".notice").filter({ hasText: "The workflows could not be read" });
      await notice.waitFor({ timeout: 20_000 });
      expect(await notice.textContent()).toContain("the daemon answered 500 on /workflows");
      expect(await dialog.getByRole("button", { name: "Create in background" }).isDisabled()).toBe(true);
      expect(await dialog.getByRole("button", { name: "Create and attach" }).isDisabled()).toBe(true);
      await page.unroute(/\/workflows(\?|$)/, broken);
      await notice.getByRole("button", { name: "Try again" }).click();
      await dialog.getByRole("button", { name: "Create and attach" }).and(page.locator(":enabled")).waitFor({
        timeout: 20_000,
      });
    } finally {
      await page.unroute(/\/workflows(\?|$)/, broken);
      if (await dialog.count()) await dialog.getByRole("button", { name: "Cancel" }).click();
    }

    // A run and a chat the daemon does not have: said, with the way back, not "in a moment" forever.
    await page.goto(app("run/does-not-exist"));
    const missing = page.getByTestId("not-found");
    await missing.waitFor({ timeout: 20_000 });
    expect(await missing.textContent()).toContain("No such run");
    expect(await missing.textContent()).toContain("does-not-exist");
    await page.goto(app("thread/nope"));
    await missing.filter({ hasText: "No such chat" }).waitFor({ timeout: 20_000 });
    await missing.getByRole("link", { name: "Back to Home" }).click();
    await page.waitForURL(/#\/inbox$/);

    // A stopped daemon keeps its sockets open: its pulse says it is not answering, on the top bar
    // and over Home, and it is connected again when it goes on.
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    const pid = daemon?.pid as number;
    process.kill(pid, "SIGSTOP");
    try {
      await page.getByTestId("connection").filter({ hasText: "not answering" }).waitFor({ timeout: 20_000 });
      const home = page.locator(".home").getByTestId("freshness");
      await home.waitFor({ timeout: 5000 });
      expect(await home.textContent()).toContain("does not answer");
      expect(await page.getByTestId("no-daemon").count()).toBe(0);
    } finally {
      process.kill(pid, "SIGCONT");
    }
    await page
      .getByTestId("connection")
      .filter({ hasText: /^connected$/ })
      .waitFor({ timeout: 20_000 });
    expect(await page.locator(".home").getByTestId("freshness").count()).toBe(0);
    expect(errors).toEqual([]);
  }, 150_000);
});
