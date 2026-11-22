/**
 * The desktop app on a folder whose repository has two worktrees of its own: the top bar counts
 * three repositories and names the one with worktrees with their count; the repository picker
 * lists each worktree as `shop (fix-tax)`, a place to work, with the dim count beside it. The
 * built app in a real Chromium against the real `metator serve`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, stopProcessesUnder } from "./helpers/cli.ts";

const ROOT = join(import.meta.dir, "..");
const WORKFLOW = "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: approval\n    hitl: true\n";

let folder: string;
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let page: Page;
const errors: string[] = [];
const app = (hash: string) => `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(base)}#/${hash}`;

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-wt-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-wt-config-"));
  folder = await mkdtemp(join(tmpdir(), "metator-desktop-wt-folder-"));
  for (const name of ["shop", "billing", "web"]) {
    const dir = join(folder, name);
    await mkdir(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    await Bun.write(join(dir, ".gitignore"), ".metator/\n");
    await Bun.write(join(dir, ".github/metator/workflows/demo.yml"), WORKFLOW);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
  }
  git(join(folder, "shop"), "worktree", "add", "-q", "-b", "fix-tax", "../shop-fix");
  git(join(folder, "shop"), "worktree", "add", "-q", "-b", "wip", "../shop-wip");
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: folder,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, METATOR_CONFIG_DIR: configDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = daemon.stderr.getReader();
  let said = "";
  const deadline = Date.now() + 30_000;
  while (!base && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    said += new TextDecoder().decode(value);
    const line = said.split("\n").find((l) => l.includes('"serving"'));
    if (line) base = (JSON.parse(line) as { serving: { url: string } }).serving.url;
  }
  reader.releaseLock();
  if (!base) throw new Error(`the daemon did not listen:\n${said}`);
  const b = await browser();
  page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
}, 120_000);

afterAll(async () => {
  await closeBrowser();
  daemon.kill("SIGTERM");
  await daemon.exited;
  stopProcessesUnder(folder);
  site.stop(true);
  await rm(folder, { recursive: true, force: true });
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("a folder with worktrees in the app (real daemon, real Chromium)", () => {
  test("the top bar counts repositories; the picker lists worktrees as places, with the dim count", async () => {
    await page.goto(app("settings"));
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    const scope = page.getByTestId("scope");
    await scope.filter({ hasText: "3 repositories" }).waitFor({ timeout: 20_000 });
    expect(await scope.getAttribute("title")).toBe("billing\nshop · 2 worktrees\nweb");
    const select = page.getByLabel("repository");
    await select.waitFor({ timeout: 20_000 });
    const options = await select.locator("option").allTextContents();
    expect(options).toEqual(["billing", "shop", "shop (fix-tax)", "shop (wip)", "web"]);
    // The chosen repository with worktrees says how many, dim, beside the picker; one without says nothing.
    const picker = page.locator("label.repo-select");
    expect(await picker.textContent()).not.toContain("worktree");
    await select.selectOption({ label: "shop (fix-tax)" });
    await picker.filter({ hasText: "· 2 worktrees" }).waitFor({ timeout: 10_000 });
    expect(await select.inputValue()).toBe("shop-fix");
    expect(errors).toEqual([]);
  }, 90_000);
});
