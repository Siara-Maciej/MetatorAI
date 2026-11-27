/**
 * A pane without a run asks, in the app (ADR-0091; real daemon, real Chromium, no real AI host): a
 * stand-in `claude` draws Claude Code's approval screen in the intake chat. The question has no
 * card: Home lists the terminal that waits, "Needs you" goes to it, its frame says "needs you",
 * and the person answers in the pane.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_APPROVAL_RAW, CLAUDE_APPROVAL_TEXT } from "@metator/testing";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
let repo: ScratchRepo;
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";

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
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-pane-ask-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-pane-ask-config-"));
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nbin/\n");
  await repo.write("bin/approval.txt", CLAUDE_APPROVAL_RAW);
  await repo.write(
    "bin/claude",
    `#!/bin/sh\ncat "${repo.path("bin/approval.txt")}"\nread -r key\nprintf '\\033[2J\\033[Hpicked %s\\n' "$key"\nsleep 60\n`,
  );
  chmodSync(repo.path("bin/claude"), 0o755);
  await repo.commit("init");
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "500"],
    {
      cwd: repo.root,
      env: {
        ...process.env,
        METATOR_STATE_DIR: E2E_STATE_DIR,
        METATOR_CONFIG_DIR: configDir,
        METATOR_CLAUDE_BIN: repo.path("bin/claude"),
      },
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
  page = await (await browser()).newPage();
}, 120_000);
afterAll(async () => {
  await page?.close();
  await closeBrowser();
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  site?.stop(true);
  await repo?.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
}, 60_000);

describe("a pane's question in the app (real daemon, real Chromium)", () => {
  test("Home lists the chat that asks, with no card; Needs you goes to its terminal, whose frame says needs you; 1 typed there answers", async () => {
    const opened = (await (
      await fetch(`${base}/panes`, {
        method: "POST",
        body: JSON.stringify({ label: "chat", role: "apps", host: "claude", agent: "mt-orchestrator" }),
      })
    ).json()) as { data: { id: string } };
    const paneId = opened.data.id;
    // Home: one line for the terminal that waits, the prompt in words; no card, nothing to click through.
    await page.goto(app("inbox"));
    // A terminal takes keys from a person with a name.
    await page.evaluate(() => localStorage.setItem("metator.me", "ana"));
    await page.reload();
    const line = page.getByTestId(`terminal-need-${paneId}`);
    await line.waitFor({ timeout: 30_000 });
    expect(await line.textContent()).toContain(CLAUDE_APPROVAL_TEXT);
    expect(await page.locator("article.card").count()).toBe(0);
    expect(await page.locator("main.content").textContent()).not.toContain("Nothing waits for you");
    // Needs you goes to that terminal: its frame says it needs the person.
    expect(await page.getByTestId("needs-count").textContent()).toContain("Needs you · 1");
    await page.getByTestId("needs-count").click();
    await page.getByTestId(`needs-you-${paneId}`).waitFor({ timeout: 30_000 });
    expect(page.url()).toContain(`#/grid/pane:${encodeURIComponent(paneId)}`);
    // The answer is typed in the pane, as in any terminal.
    await page.getByTestId(`frame-${paneId}`).locator(".xterm").click();
    await page.keyboard.type("1");
    await page.keyboard.press("Enter");
    await until("the pane to pick 1", async () => {
      const r = (await (await fetch(`${base}/panes/${paneId}`)).json()) as { data: { text: string } };
      return r.data.text.includes("picked 1") ? true : undefined;
    });
    // The host redrew its screen without the prompt: nothing waits any more.
    await until("Needs you to go to 0", async () =>
      (await page.getByTestId("needs-count").textContent())?.includes("Needs you · 0") ? true : undefined,
    );
  }, 120_000);
});
