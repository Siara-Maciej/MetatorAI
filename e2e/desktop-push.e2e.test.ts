/**
 * The desktop app reads again what the daemon says changed (ADR-0110), end to end: the built app in
 * a real Chromium over the real daemon. On the Backlog, with `/ws/events` live, the list of issues
 * is asked only as a fallback (once in 30 s at most, not every 2 s); an issue another client adds
 * is on the screen within seconds, because the daemon said `backlog` changed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
let repo: ScratchRepo;
let dist = "";
let configDir = "";
let site: ReturnType<typeof Bun.serve>;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let page: Page;
const errors: string[] = [];
const app = (hash: string) => `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(base)}#/${hash}`;

async function until<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-push-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-push-config-"));
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.commit("init");
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--supervise-ms", "0", "--intake-ms", "0"], {
    cwd: repo.root,
    env: {
      ...process.env,
      METATOR_STATE_DIR: E2E_STATE_DIR,
      METATOR_CONFIG_DIR: configDir,
      METATOR_HOST: "scenario",
      METATOR_NO_REAL_HOSTS: "1",
    },
    stdout: "pipe",
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
  void (async () => {
    for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return;
  })();
  page = await (await browser()).newPage({ viewport: { width: 1440, height: 900 } });
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
  site?.stop(true);
  await repo?.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
}, 60_000);

describe("the app hears of changes from the daemon (ADR-0110)", () => {
  test("the Backlog asks for issues only as a fallback, and shows a new one at once", async () => {
    const asked: number[] = [];
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (r.method() === "GET" && url.pathname === "/issues") asked.push(Date.now());
    });
    await page.goto(app("backlog"));
    await page.getByTestId("connection").getByText("connected").waitFor();
    await page.locator(".backlog").waitFor();
    // Once the channel said hello, the 2-second poll of the list is a 30-second fallback.
    await page.waitForTimeout(3000);
    const before = asked.length;
    await page.waitForTimeout(8000);
    expect(asked.length - before).toBeLessThanOrEqual(1);

    // Another client adds an issue: the daemon says `backlog` changed and the list is read again.
    const added = Date.now();
    const r = await fetch(`${base}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "Pushed by another client", by: "bob" }),
    });
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    await page.getByText("Pushed by another client").first().waitFor({ timeout: 5000 });
    expect(Date.now() - added).toBeLessThan(5000);
    expect(errors.filter((e) => !/favicon|Notification/.test(e))).toEqual([]);
  }, 60_000);
});
