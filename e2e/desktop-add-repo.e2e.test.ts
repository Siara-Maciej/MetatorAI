/**
 * Add repository in the desktop app (round 20, ADR-0105): the built app in a real Chromium, the
 * shell's commands replaced by the fake through its test hook (`window.__METATOR_FAKE__`), and a
 * real `metator serve` (the scenario host's world: no real AI host) for what "Open" points at.
 * First run → Add repository → inspect → setup with streamed lines → the commit card → Commit →
 * Open → the switcher shows it → Remove from the app → the first run again. Then the web build's
 * fallback and the app's settings.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { FakeWorld } from "../packages/desktop/src/fake-commands.ts";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
const SHOTS = process.env.METATOR_SHOTS;
const SHOP = "/home/you/shop";
const FILES = [
  ".claude/agents/mt-implementer.md",
  ".github/hooks/metator.json",
  "metator.config.yml",
  "metator/install.lock.json",
];
const LINES = [
  "Checking git and the hosts…",
  "Wrote metator.config.yml",
  "Wrote .claude/agents/mt-implementer.md",
  "Wrote .github/hooks/metator.json",
  "Wrote metator/install.lock.json",
];
const NOWHERE = {
  METATOR_COPILOT_BIN: "/nonexistent/copilot",
  METATOR_CLAUDE_BIN: "/nonexistent/claude",
  METATOR_OPENCODE_BIN: "/nonexistent/opencode",
};

let repo: ScratchRepo;
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let daemon: Bun.Subprocess | undefined;
let port = 0;
const errors: string[] = [];

const base = () => `http://127.0.0.1:${port}`;
/** The app, with an address nothing answers at: what it shows comes from the shell, not a daemon found by chance. */
const app = (hash: string) =>
  `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent("http://127.0.0.1:9")}#/${hash}`;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}

/** A page whose shell is the fake, with this world. */
async function withFake(world: FakeWorld): Promise<Page> {
  const b = await browser();
  const page = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  await page.addInitScript((w) => {
    (window as unknown as { __METATOR_FAKE__: unknown }).__METATOR_FAKE__ = w;
  }, world);
  return page;
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const calls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __METATOR_FAKE__: FakeWorld }).__METATOR_FAKE__.calls ?? [],
  ) as Promise<{ command: string; args: unknown[] }[]>;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-add-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-add-config-"));
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.commit("init");
  // The daemon "Open" points at: the real one, with no AI host it could start.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  port = probe.port as number;
  await probe.stop(true);
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", String(port), "--poll-ms", "100", "--supervise-ms", "0"],
    {
      cwd: repo.root,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, METATOR_CONFIG_DIR: configDir, ...NOWHERE },
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
}, 120_000);

afterAll(async () => {
  await closeBrowser();
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  stopProcessesUnder(repo.root);
  site.stop(true);
  await repo.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("Add repository in the desktop app (the shell faked, a real daemon to open)", () => {
  test("first run → Add → inspect → setup (streamed) → commit card → Commit → Open → switcher → Remove", async () => {
    const page = await withFake({
      folders: { [SHOP]: { kind: "repo", setUp: "no", writes: FILES } },
      hosts: [
        { id: "copilot", installed: false },
        { id: "claude", installed: true, loggedIn: true },
      ],
      picked: SHOP,
      setupLines: LINES,
      lineMs: 30,
      holdSetup: true,
      url: base(),
    });
    try {
      // First run: one button, and what MetatorAI needs, checked.
      await page.goto(app("inbox"));
      const first = page.getByTestId("first-run");
      await first.waitFor({ timeout: 20_000 });
      await first.getByTestId("requirements").waitFor({ timeout: 10_000 });
      expect(await first.getByTestId("requirements").textContent()).toContain("Claude Code");
      expect(await page.locator(".sessions").count()).toBe(0);
      await shot(page, "first-run");

      // Add repository: the folder picker, then what the app found, in words.
      await first.getByRole("link", { name: "Add repository" }).click();
      const add = page.getByTestId("add-repo");
      await add.getByRole("button", { name: "Choose folder…" }).click();
      const found = add.getByTestId("inspection");
      await found.waitFor({ timeout: 10_000 });
      expect(await found.getAttribute("data-kind")).toBe("not-set-up");
      expect(await found.textContent()).toContain("MetatorAI is not set up here yet");
      expect(await found.textContent()).toContain("Setup will write 4 files.");
      expect(await add.getByTestId("will-write").locator("li").allTextContents()).toEqual(FILES);
      // Only an installed host can be chosen; the first installed is chosen.
      const hosts = add.getByTestId("hosts");
      expect(await hosts.getByLabel(/GitHub Copilot CLI/).isDisabled()).toBe(true);
      expect(await hosts.getByLabel(/Claude Code/).isChecked()).toBe(true);
      await shot(page, "add-inspection");

      // Set up: one progress line, the whole output behind "Show output".
      await add.getByRole("button", { name: "Set up" }).click();
      const progress = add.getByTestId("progress-line");
      await progress.filter({ hasText: "Wrote metator/install.lock.json" }).waitFor({ timeout: 10_000 });
      expect(await add.getByTestId("setup-output").count()).toBe(0);
      await add.getByRole("button", { name: "Show output" }).click();
      expect(await add.getByTestId("setup-output").textContent()).toBe(LINES.join("\n"));
      await shot(page, "setup-in-progress");
      await page.evaluate(() =>
        (
          window as unknown as { __METATOR_FAKE_CONTROL__: { finishSetup(): void } }
        ).__METATOR_FAKE_CONTROL__.finishSetup(),
      );

      // The commit card: the person's choice, only the files setup wrote.
      const card = add.getByTestId("commit-card");
      await card.waitFor({ timeout: 10_000 });
      expect(await card.getByRole("heading").textContent()).toBe("Setup wrote 4 files. Commit them?");
      expect(await card.locator(".files li").allTextContents()).toEqual(FILES);
      expect(await card.getByRole("button", { name: "Not now" }).isEnabled()).toBe(true);
      await shot(page, "commit-card");
      await card.getByRole("button", { name: "Commit" }).click();
      const ready = add.getByTestId("ready");
      await ready.filter({ hasText: "Committed as 4f2c9e1." }).waitFor({ timeout: 10_000 });
      const commit = (await calls(page)).filter((c) => c.command === "commit_setup");
      expect(commit).toEqual([{ command: "commit_setup", args: [SHOP, FILES] }]);
      expect((await calls(page)).filter((c) => c.command === "run_setup")[0]?.args).toEqual([SHOP, "claude"]);

      // Open: the app remembers it, starts its daemon and shows it.
      await ready.getByRole("button", { name: "Open" }).click();
      await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 30_000 });
      await until("Home", async () => (page.url().endsWith("#/inbox") ? true : undefined));
      expect(
        (await calls(page)).filter((c) => c.command === "add_repo" || c.command === "open_repo"),
      ).toEqual([
        { command: "add_repo", args: [SHOP] },
        { command: "open_repo", args: [SHOP] },
      ]);

      // The switcher names it, marked as the open one, with Add and Remove.
      const scope = page.getByTestId("scope");
      expect((await scope.textContent())?.startsWith("shop")).toBe(true);
      await scope.click();
      const menu = page.getByRole("menu", { name: "repositories" });
      await menu.waitFor({ timeout: 5000 });
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
        "✓ shop",
        "Add repository…",
        "Remove shop from the app",
      ]);
      await shot(page, "switcher");
      await menu.getByRole("menuitem", { name: "Remove shop from the app" }).click();
      // The last repository is gone from the app: the first run again; its files were never touched.
      await page.getByTestId("first-run").waitFor({ timeout: 10_000 });
      expect((await calls(page)).filter((c) => c.command === "remove_repo")).toEqual([
        { command: "remove_repo", args: [SHOP] },
      ]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 120_000);

  test("a repository already set up is just added and opened; a known one is opened, not set up again", async () => {
    const page = await withFake({
      folders: { "/home/you/done": { kind: "repo", setUp: "yes" }, "/home/you/notes": { kind: "not-git" } },
      url: base(),
    });
    try {
      await page.goto(app("add"));
      const add = page.getByTestId("add-repo");
      // A folder that is not a repository: git init is offered, and is a click.
      await add.getByLabel("folder path").fill("/home/you/notes");
      await add.getByRole("button", { name: "Continue" }).click();
      const found = add.getByTestId("inspection");
      await found.filter({ hasText: "This folder is not a git repository" }).waitFor({ timeout: 10_000 });
      await add.getByRole("button", { name: "Make it a git repository" }).click();
      await found.filter({ hasText: "MetatorAI is not set up here yet" }).waitFor({ timeout: 10_000 });
      expect((await calls(page)).filter((c) => c.command === "git_init")).toEqual([
        { command: "git_init", args: ["/home/you/notes"] },
      ]);
      // Another folder: set up already, so no setup, no commit card.
      await add.getByRole("button", { name: "Change" }).click();
      await add.getByLabel("folder path").fill("/home/you/done");
      await add.getByRole("button", { name: "Continue" }).click();
      await found.filter({ hasText: "MetatorAI is already set up here" }).waitFor({ timeout: 10_000 });
      await add.getByRole("button", { name: "Add and open" }).click();
      await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 30_000 });
      expect((await calls(page)).some((c) => c.command === "run_setup")).toBe(false);
      // Added already: the app says so and opens it.
      await page.goto(app("add"));
      await add.getByLabel("folder path").fill("/home/you/done");
      await add.getByRole("button", { name: "Continue" }).click();
      await found.filter({ hasText: "Already in the app" }).waitFor({ timeout: 10_000 });
      expect(await add.getByRole("button", { name: "Open" }).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a missing tool has its install link and Retry; Settings says where metator comes from and installs the command", async () => {
    const page = await withFake({ folders: {}, hosts: [], url: base() });
    try {
      await page.goto(app("inbox"));
      const needs = page.getByTestId("requirements");
      await needs.waitFor({ timeout: 20_000 });
      expect(await needs.getByRole("link", { name: "How to install" }).count()).toBe(2);
      expect(await needs.getByRole("button", { name: "Retry" }).count()).toBe(1);
      await page.goto(app("app"));
      const settings = page.getByTestId("app-settings");
      await settings.getByTestId("cli-info").waitFor({ timeout: 10_000 });
      expect(await settings.getByTestId("cli-info").textContent()).toContain("Bundled with the app");
      await settings.getByRole("button", { name: "Install the metator command" }).click();
      await settings.getByText("Wrote /home/you/.local/bin/metator.").waitFor({ timeout: 5000 });
      expect(await settings.getByTestId("installed-at").textContent()).toBe(
        "Installed at /home/you/.local/bin/metator",
      );
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the web build has no shell: Add repository lists the commands and says the desktop app does them", async () => {
    const b = await browser();
    const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(app("add"));
      const web = page.getByTestId("add-repo-web");
      await web.waitFor({ timeout: 20_000 });
      expect(await web.textContent()).toContain("The desktop app does this for you");
      await web.getByLabel("folder path").fill("/home/you/my shop");
      await web.getByLabel("AI host").selectOption("copilot");
      expect(await web.getByTestId("web-commands").textContent()).toBe(
        [
          'cd "/home/you/my shop"',
          "metator inspect .",
          "metator setup --host copilot --yes",
          "metator setup --commit --files <the files setup listed>",
          "metator serve",
        ].join("\n"),
      );
      // The panel with no daemon points at it.
      await page.goto(app("inbox"));
      await page
        .getByTestId("no-daemon")
        .getByRole("link", { name: "Add repository" })
        .waitFor({ timeout: 20_000 });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
