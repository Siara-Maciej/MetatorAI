/**
 * A pane without a run asks, in the app (ADR-0091; real daemon, real Chromium, no real AI host): a
 * stand-in `claude` draws Claude Code's approval screen in the intake chat. Home shows the pane's
 * card (its readable prompt, the pane, its choices), the chat's frame in Terminals says
 * "needs you", and Yes sent from the card is typed into the pane as its number.
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
    `#!/bin/sh\ncat "${repo.path("bin/approval.txt")}"\nread -r key\nprintf 'picked %s\\n' "$key"\nsleep 60\n`,
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
  test("Home shows the chat's approval with its choices; its frame says needs you; Yes from the card picks 1 in the pane", async () => {
    const opened = (await (
      await fetch(`${base}/panes`, {
        method: "POST",
        body: JSON.stringify({ label: "chat", role: "apps", host: "claude", agent: "mt-orchestrator" }),
      })
    ).json()) as { data: { id: string } };
    const paneId = opened.data.id;
    // Terminals: the chat's frame says it needs the person.
    await page.goto(app(`grid/pane:${paneId}`));
    await page.getByTestId(`needs-you-${paneId}`).waitFor({ timeout: 30_000 });
    // Home: the pane's own card, the prompt in words, and the choices of the host's menu.
    await page.goto(app("inbox"));
    const card = page.getByTestId(`pane-ask-${paneId}`);
    await card.waitFor({ timeout: 30_000 });
    expect(await card.locator("h1").textContent()).toBe(CLAUDE_APPROVAL_TEXT);
    expect(await card.getByTestId("pane-asker").textContent()).toContain("chat pane");
    const labels = await card.locator(".option .label").allTextContents();
    expect(labels.slice(0, 2)).toEqual(["Yes", "Yes, and don't ask again for: metator workflow *"]);
    await card.getByRole("radio").first().check();
    await card.getByRole("button", { name: "Send" }).click();
    const named = page.getByRole("dialog", { name: "your name" });
    if (await named.isVisible({ timeout: 2000 }).catch(() => false)) {
      await named.getByLabel("Your name").fill("ana");
      await named.getByRole("button", { name: "Save" }).click();
    }
    await until("the pane to pick 1", async () => {
      const r = (await (await fetch(`${base}/panes/${paneId}`)).json()) as { data: { text: string } };
      return r.data.text.includes("picked 1") ? true : undefined;
    });
    // The card is gone from Home.
    await until("the card to go", async () => ((await card.count()) === 0 ? true : undefined));
  }, 120_000);
});
