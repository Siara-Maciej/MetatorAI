/**
 * Add repository from a dev container in the desktop app (round 21, ADR-0106): the built app in a
 * real Chromium, the shell's commands replaced by the fake through its test hook
 * (`window.__METATOR_FAKE__`, with a fake container engine), and a real `metator serve` (the
 * scenario host's world: no real AI host) for what "Open" points at.
 * Add repository → Dev Container → Start a stopped one → Choose → the install's progress → the
 * host check in the container → Set up → Commit → Open → the switcher shows "(Dev Container)".
 * Then no engine and no dev container in words, and a container that stopped: Start, reconnected.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { FakeContainer, FakeWorld } from "../packages/desktop/src/fake-commands.ts";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
const SHOTS = process.env.METATOR_SHOTS;
const SHOP = "C:\\Users\\you\\src\\shop";
const SHOP_KEY = `devcontainer:${SHOP}`;
const WORKSPACE = "/workspaces/shop";
const FILES = [".claude/agents/mt-implementer.md", "metator.config.yml", "metator/install.lock.json"];
const INSTALL = [
  "Container shop_devcontainer-app-1: x86_64, glibc 2.36, user vscode",
  "Copying MetatorAI 0.0.0 (linux-x64, 61 MB)…",
  "Unpacking into ~/.metator/server/0.0.0…",
  "Checking metator version…",
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

const control = (page: Page, what: "finishInstall" | "finishSetup") =>
  page.evaluate(
    (w) =>
      (
        window as unknown as { __METATOR_FAKE_CONTROL__: Record<string, () => void> }
      ).__METATOR_FAKE_CONTROL__[w]?.(),
    what,
  );

const shopBox = (more: Partial<FakeContainer> = {}): FakeContainer => ({
  id: "4b1e0c9d2f3a",
  name: "shop_devcontainer-app-1",
  localFolder: SHOP,
  state: "stopped",
  workspaceFolder: WORKSPACE,
  folders: { [WORKSPACE]: { kind: "repo", setUp: "no", writes: FILES } },
  hosts: [
    { id: "copilot", installed: false },
    { id: "claude", installed: false },
  ],
  ...more,
});

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-dc-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-dc-config-"));
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.commit("init");
  // The daemon "Open" points at (in the app, the tunnel's loopback end): the real one, no AI host.
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

describe("Add repository from a dev container (the shell and its engine faked, a real daemon to open)", () => {
  test("Dev Container → Start → Choose → install → host check → Set up → Commit → Open → the switcher", async () => {
    const page = await withFake({
      folders: {},
      containers: [
        shopBox(),
        {
          id: "9a8b7c6d5e4f",
          name: "notes_devcontainer-app-1",
          localFolder: "C:\\Users\\you\\src\\notes",
          state: "running",
          workspaceFolder: "/workspaces/notes",
          folders: {},
        },
      ],
      installLines: INSTALL,
      holdInstall: true,
      setupLines: ["Checking git and the hosts…", "Wrote metator.config.yml"],
      lineMs: 30,
      url: base(),
    });
    try {
      // The first run's one button, then the third source.
      await page.goto(app("inbox"));
      await page.getByTestId("first-run").getByRole("link", { name: "Add repository" }).click();
      const add = page.getByTestId("add-repo");
      const sources = add.getByTestId("sources");
      expect(await sources.getByRole("tab").allTextContents()).toEqual([
        "Folder on this computer",
        "Folder of repositories",
        "Dev Container",
      ]);
      await sources.getByRole("tab", { name: "Dev Container" }).click();
      const list = add.getByTestId("container-list");
      await list.waitFor({ timeout: 10_000 });
      const boxes = add.getByTestId("containers");
      expect(await boxes.getByRole("heading").textContent()).toBe("2 dev containers on this computer");
      expect(await boxes.textContent()).toContain("docker (context rancher-desktop)");
      const shop = list.locator("li", { hasText: "shop" });
      expect(await shop.locator(".state").textContent()).toBe("stopped");
      expect(await shop.locator(".path").textContent()).toBe(WORKSPACE);
      expect(await list.locator("li", { hasText: "notes" }).getByRole("button").textContent()).toBe("Choose");
      await shot(page, "container-list");

      // Start the stopped one: it runs, and can be chosen.
      await shop.getByRole("button", { name: "Start" }).click();
      await shop.locator(".state", { hasText: "running" }).waitFor({ timeout: 10_000 });
      await shop.getByRole("button", { name: "Choose" }).click();

      // MetatorAI is installed into it, with its progress as one line.
      const install = add.getByTestId("install-progress");
      await install.waitFor({ timeout: 10_000 });
      await add
        .getByTestId("install-line")
        .filter({ hasText: "Checking metator version…" })
        .waitFor({ timeout: 10_000 });
      expect(await install.textContent()).toContain("Installing MetatorAI in the dev container of shop");
      await add.getByRole("button", { name: "Show output" }).click();
      expect(await add.getByTestId("setup-output").textContent()).toBe(INSTALL.join("\n"));
      await shot(page, "install-progress");
      await control(page, "finishInstall");

      // The same inspection, in the container, with its host check: no AI host there yet, each
      // with the engine's fix (a devcontainer.json feature line, or a command for its terminal).
      const found = add.getByTestId("inspection");
      await found.waitFor({ timeout: 10_000 });
      expect(await found.getAttribute("data-kind")).toBe("no-host");
      expect(await found.getByRole("heading", { level: 2 }).textContent()).toBe(
        "No AI host is installed in the container",
      );
      expect(await add.getByTestId("where").textContent()).toContain("shop (Dev Container)");
      const check = add.getByTestId("container-check");
      expect(await check.getByRole("heading").textContent()).toBe("In the container");
      const claude = check.locator("li", { hasText: "Claude Code" });
      expect(await claude.textContent()).toContain("not installed");
      expect(await claude.getByTestId("fix").textContent()).toContain(
        '"ghcr.io/anthropics/devcontainer-features/claude-code:1": {}',
      );
      expect(
        await check.locator("li", { hasText: "GitHub Copilot CLI" }).getByTestId("fix").textContent(),
      ).toContain("npm install -g @github/copilot");
      expect(await check.locator("li", { hasText: "git" }).first().getAttribute("class")).toBe("ok");
      await shot(page, "host-check-in-container");
      // The person adds the feature and rebuilds; Retry reads the container again.
      await page.evaluate(() => {
        const w = (window as unknown as { __METATOR_FAKE__: FakeWorld }).__METATOR_FAKE__;
        const box = w.containers?.[0];
        if (box) box.hosts = [{ id: "claude", installed: true, loggedIn: true }];
      });
      await check.getByRole("button", { name: "Retry" }).click();
      await found
        .filter({ hasText: "MetatorAI is not set up in the container yet" })
        .waitFor({ timeout: 10_000 });
      expect(await check.locator("li").evaluateAll((li) => li.map((l) => l.className))).toEqual(["ok", "ok"]);
      // Every inspection of the folder ran in the container (the first run's check is this computer's).
      expect((await calls(page)).filter((c) => c.command === "inspect_folder" && c.args[0] !== ".")).toEqual([
        { command: "inspect_folder", args: [WORKSPACE, SHOP] },
        { command: "inspect_folder", args: [WORKSPACE, SHOP] },
      ]);

      // Set up, Commit, Open: the round-20 steps, each run in the container.
      await add.getByRole("button", { name: "Set up" }).click();
      const card = add.getByTestId("commit-card");
      await card.waitFor({ timeout: 10_000 });
      await card.getByRole("button", { name: "Commit" }).click();
      const ready = add.getByTestId("ready");
      await ready.filter({ hasText: "Committed as 4f2c9e1." }).waitFor({ timeout: 10_000 });
      await ready.getByRole("button", { name: "Open" }).click();
      await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 30_000 });
      const seen = await calls(page);
      expect(
        seen
          .filter((c) =>
            [
              "start_devcontainer",
              "install_in_container",
              "run_setup",
              "commit_setup",
              "add_repo",
              "open_repo",
            ].includes(c.command),
          )
          .map((c) => [c.command, ...c.args]),
      ).toEqual([
        ["start_devcontainer", SHOP],
        ["install_in_container", SHOP],
        ["run_setup", WORKSPACE, "claude", SHOP],
        ["commit_setup", WORKSPACE, FILES, SHOP],
        ["add_repo", WORKSPACE, SHOP],
        ["open_repo", SHOP_KEY],
      ]);

      // The switcher names it as a dev container, with its container's state.
      const scope = page.getByTestId("scope");
      await until("the switcher to name it", async () =>
        (await scope.textContent())?.startsWith("shop (Dev Container)") ? true : undefined,
      );
      await scope.click();
      const menu = page.getByRole("menu", { name: "repositories" });
      await menu.waitFor({ timeout: 5000 });
      await menu
        .getByRole("menuitem", { name: "✓ shop (Dev Container) · running" })
        .waitFor({ timeout: 5000 });
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
        "✓ shop (Dev Container) · running",
        "Add repository…",
        "Remove shop (Dev Container) from the app",
      ]);
      await shot(page, "switcher");
      await page.keyboard.press("Escape");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 120_000);

  test("no engine, and an engine with no dev container, in plain words", async () => {
    const page = await withFake({ folders: {}, engine: null, url: base() });
    try {
      await page.goto(app("add"));
      const add = page.getByTestId("add-repo");
      await add.getByTestId("sources").getByRole("tab", { name: "Dev Container" }).click();
      const boxes = add.getByTestId("containers");
      await boxes.filter({ hasText: "No container engine found" }).waitFor({ timeout: 10_000 });
      expect(await boxes.getAttribute("data-kind")).toBe("no-engine");
      expect(await boxes.getByRole("link").allTextContents()).toEqual(["Docker Desktop", "Rancher Desktop"]);
      // The engine comes up, with no dev container yet: Refresh says so.
      await page.evaluate(() => {
        (window as unknown as { __METATOR_FAKE__: FakeWorld }).__METATOR_FAKE__.engine = {
          program: "nerdctl",
          context: null,
          version: "2.0.3",
        };
      });
      await boxes.getByRole("button", { name: "Refresh" }).click();
      await boxes.filter({ hasText: "No dev container yet" }).waitFor({ timeout: 10_000 });
      expect(await boxes.textContent()).toContain("devcontainer up");
      expect(await boxes.textContent()).toContain("nerdctl answers");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a known dev container whose container stopped: the panel offers Start and Reconnect", async () => {
    const page = await withFake({
      folders: {},
      containers: [shopBox({ installed: "0.0.0", folders: { [WORKSPACE]: { kind: "repo", setUp: "yes" } } })],
      known: [
        {
          path: SHOP_KEY,
          name: "shop",
          kind: "devcontainer",
          addedAt: "2026-11-23T10:00:00Z",
          devcontainer: {
            localFolder: SHOP,
            workspaceFolder: WORKSPACE,
            configFile: null,
            editorUri: "vscode://vscode-remote/dev-container+00",
          },
        },
      ],
      url: base(),
    });
    try {
      await page.goto(app("inbox"));
      const down = page.getByTestId("container-down");
      await down.waitFor({ timeout: 20_000 });
      await down.filter({ hasText: "The container stopped" }).waitFor({ timeout: 10_000 });
      expect(await down.getByRole("button").allTextContents()).toEqual(["Start", "Reconnect"]);
      await shot(page, "container-stopped");
      await down.getByRole("button", { name: "Start" }).click();
      await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 30_000 });
      expect(await page.getByTestId("container-down").count()).toBe(0);
      expect((await calls(page)).filter((c) => c.command === "start_devcontainer")).toEqual([
        { command: "start_devcontainer", args: [SHOP] },
      ]);
      // Settings lists it as a dev container, with Remove from the app.
      await page.goto(app("app"));
      const settings = page.getByTestId("app-settings");
      const row = settings.getByTestId("known-repos").locator("li");
      await row.filter({ hasText: "shop (Dev Container)" }).waitFor({ timeout: 10_000 });
      expect(await row.textContent()).toContain(`${WORKSPACE} in the container of ${SHOP}`);
      expect(await row.getByRole("button", { name: "Remove from the app" }).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
