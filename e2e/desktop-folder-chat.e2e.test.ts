/**
 * The chat of a folder in the app (ADR-0113; real daemon on a folder of two repositories, real
 * Chromium, the scenario host only, never a real AI host). "+ New chat" opens the folder's own
 * chat, started in the folder, and says so on its page and in its sidebar row; the menu beside
 * the button opens a chat in one repository instead. No browser fixture: what the app shows comes
 * from the daemon's routes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, stopProcessesUnder } from "./helpers/cli.ts";

const ROOT = join(import.meta.dir, "..");
const SHOTS = process.env.METATOR_SHOTS;
const CONFIG = "kind: MetatorConfig\nschemaVersion: 13\nsupervisor:\n  hostOrder: [scenario]\n";
const CHAT = `    - - say: "I am the chat."
      - run: 'echo "started in $(basename "$PWD")"'
      - run: 'sleep 300'
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-chat:
${CHAT}  mt-orchestrator:
${CHAT}`;

let folder: string;
let dist: string;
let configDir: string;
let bin: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
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
const api = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as { data: never };
type Thread = { id: string; repo?: string; panes: { paneId: string; repo?: string }[] };
const threads = async () => ((await api("/threads")) as { data: { threads: Thread[] } }).data.threads;
type Pane = { id: string; cwd: string; threadId?: string };
const panesOf = async (repo: string) =>
  ((await api(`/layout?repo=${encodeURIComponent(repo)}`)) as { data: { panes: Pane[] } }).data.panes;
async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-c", "user.email=ana@example.com", "-c", "user.name=ana", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await p.exited) !== 0)
    throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-folder-chat-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-folder-chat-config-"));
  bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  chmodSync(join(bin, "metator"), 0o755);
  folder = await realpath(await mkdtemp(join(tmpdir(), "metator-folder-chat-app-")));
  for (const name of ["shop", "web"]) {
    const root = join(folder, name);
    await mkdir(root, { recursive: true });
    await Bun.write(join(root, ".gitignore"), ".metator/\n");
    await Bun.write(join(root, "metator.config.yml"), CONFIG);
    await Bun.write(
      join(root, ".claude/agents/mt-chat.md"),
      await Bun.file(join(ROOT, ".claude/agents/mt-chat.md")).text(),
    );
    await git(root, "init", "-q");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "init");
  }
  await Bun.write(join(folder, "scenario.yml"), SCENARIO);
  const env = {
    METATOR_CONFIG_DIR: configDir,
    METATOR_USER: "ana",
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: join(folder, "scenario.yml"),
    METATOR_NO_REAL_HOSTS: "1",
    METATOR_CLAUDE_BIN: "/nonexistent/claude",
    METATOR_COPILOT_BIN: "/nonexistent/copilot",
    METATOR_OPENCODE_BIN: "/nonexistent/opencode",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "500"],
    {
      cwd: folder,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = daemon.stderr.getReader();
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
  page = await (await browser()).newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
}, 120_000);
afterAll(async () => {
  await page?.close();
  await closeBrowser();
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  stopProcessesUnder(folder);
  site?.stop(true);
  await rm(folder, { recursive: true, force: true });
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
}, 60_000);

async function nameIfAsked() {
  const who = page.getByRole("dialog", { name: "your name" });
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
/** The thread a click made, once the app shows its chat. */
async function made(click: () => Promise<void>): Promise<Thread> {
  const before = (await threads()).map((t) => t.id);
  await click();
  await nameIfAsked();
  const thread = await until("the new thread", async () =>
    (await threads()).find((t) => !before.includes(t.id)),
  );
  await until("the app on the new chat", async () =>
    page.url().endsWith(`#/thread/${thread.id}`) ? true : undefined,
  );
  return thread;
}
async function chatSays(thread: Thread, words: string) {
  const screen = page.getByTestId(`thread-${thread.id}`);
  await until(`the chat of ${thread.id} to say "${words}"`, async () =>
    (
      await screen
        .locator(".pane-frame")
        .textContent({ timeout: 1000 })
        .catch(() => "")
    )?.includes(words)
      ? true
      : undefined,
  );
}
const sidebar = () => page.getByRole("complementary", { name: "runs" });

describe("the chat of a folder in the app (ADR-0113)", () => {
  test('"+ New chat" on a folder of two repositories opens the folder\'s own chat, started in the folder', async () => {
    await page.goto(app("inbox"));
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    await sidebar().getByText("No chat yet.").waitFor({ timeout: 20_000 });
    const thread = await made(() => page.getByRole("button", { name: "+ New chat" }).click());
    expect(thread.repo).toBe(".");
    expect(thread.panes).toMatchObject([{ repo: "." }]);
    // Its pane is the folder's, in the folder; neither repository got one.
    const own = await panesOf(".");
    expect(own.map((p) => [p.threadId, p.cwd])).toEqual([[thread.id, folder]]);
    expect(await panesOf("shop")).toEqual([]);
    expect(await panesOf("web")).toEqual([]);
    // The app shows its terminal and says whose chat it is, on its page and in its row.
    await chatSays(thread, `started in ${folder.split("/").pop()}`);
    expect(await page.getByTestId("thread-place").textContent()).toBe("· folder");
    const head = sidebar().getByTestId(`side-thread-${thread.id}`).locator(".thread-head");
    await until("the row to say folder", async () =>
      (await head.textContent())?.includes("folder") ? true : undefined,
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "folder-chat.png") });
  }, 90_000);

  test("the menu beside the button opens a chat in one repository instead", async () => {
    await page.getByTestId("new-chat-where").click();
    const menu = page.getByRole("menu", { name: "where the new chat opens" });
    expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
      "New chat in the folder",
      "New chat in shop",
      "New chat in web",
    ]);
    const thread = await made(() => menu.getByRole("menuitem", { name: "New chat in web" }).click());
    expect(thread.repo).toBe("web");
    expect((await panesOf("web")).map((p) => [p.threadId, p.cwd])).toEqual([
      [thread.id, join(folder, "web")],
    ]);
    await chatSays(thread, "started in web");
    expect(await page.getByTestId("thread-place").textContent()).toBe("· web");
    expect(errors).toEqual([]);
  }, 90_000);
});
