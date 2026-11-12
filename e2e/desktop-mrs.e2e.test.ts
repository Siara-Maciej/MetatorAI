/**
 * The Open MRs screen end to end (T3, design/14 §4): the built app in a real Chromium over the
 * real daemon, which reads my request's review through a real MCP server process (a stand-in
 * for GitHub). The thread shows with its proposed reply; "Send" posts it under my name.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
const FAKE = join(import.meta.dir, "helpers/fake-mcp-server.ts");
const ID = "github-acme-shop-45";
/** Where a screenshot of the screen is kept when METATOR_SHOTS names a directory. */
const SHOTS = process.env.METATOR_SHOTS;

let repo: ScratchRepo;
let daemon: Bun.Subprocess<"ignore", "ignore", "pipe">;
let daemonUrl = "";
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
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

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-mrs-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-mrs-config-"));
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\npulls.json\nmcp.log\n");
  await repo.write("src/discount.ts", "export const discount = 0.1;\nexport const cap = 100;\n");
  await repo.write(
    ".github/metator/workflows/mt-review-response.yml",
    "kind: Workflow\nschemaVersion: 2\nid: mt-review-response\nstages:\n  - id: triage\n    owner: mt-review-responder\n  - id: approval\n    hitl: true\n",
  );
  await repo.write(
    "metator.config.yml",
    `kind: MetatorConfig
schemaVersion: 11
mcp:
  github:
    command: bun
    args: ["${FAKE}"]
    env:
      FAKE_MCP_PULLS: "${repo.path("pulls.json")}"
      FAKE_MCP_LOG: "${repo.path("mcp.log")}"
reviews:
  everyMs: 1000
  sources:
    - { kind: github, repo: acme/shop, author: maciej }
`,
  );
  await repo.commit("init");
  await repo.git("branch", "feat/cap");
  await repo.write(
    "pulls.json",
    JSON.stringify({
      pulls: [
        {
          number: 45,
          title: "Cap the discount",
          head: { ref: "feat/cap" },
          html_url: "https://example.com/45",
          user: { login: "maciej" },
        },
      ],
      threads: {
        "45": [
          {
            id: "T1",
            isResolved: false,
            comments: [
              {
                id: 101,
                body: "Is the cap in cents?",
                author: { login: "anna" },
                path: "src/discount.ts",
                line: 2,
              },
            ],
          },
          {
            id: "T2",
            isResolved: false,
            comments: [
              {
                id: 102,
                body: "Please name the unit in the constant.",
                author: { login: "anna" },
                path: "src/discount.ts",
                line: 2,
              },
            ],
          },
        ],
      },
    }),
  );
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0", "--intake-ms", "0"],
    {
      cwd: repo.root,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, METATOR_CONFIG_DIR: configDir },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const reader = daemon.stderr.getReader();
  let text = "";
  daemonUrl = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
  const b = await browser();
  page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
}, 180_000);

afterAll(async () => {
  await closeBrowser();
  daemon.kill("SIGTERM");
  await daemon.exited;
  site.stop(true);
  await repo.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("MetatorAI Desktop: Open MRs (real daemon, real Chromium, real MCP server process)", () => {
  test("my reviewed request shows with its threads; the proposed reply is sent under my name", async () => {
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/mrs`);
    const screen = page.getByTestId("mrs");
    await screen.waitFor({ timeout: 20_000 });
    // The daemon's own scan finds the review within its interval.
    await page.getByTestId(`mr-${ID}`).waitFor({ timeout: 40_000 });
    expect(await page.getByTestId(`mr-${ID}`).textContent()).toContain("#45 Cap the discount");
    expect(await page.getByTestId(`mr-${ID}`).textContent()).toContain("2 open");
    expect(await page.getByTestId("thread-T1").textContent()).toContain("Is the cap in cents?");
    expect(await page.getByTestId("thread-T1").textContent()).toContain("anna · src/discount.ts:2");
    // The answering run was started by the scan; the agent's triage is recorded with the CLI.
    await until("the answering run", async () =>
      (await screen.textContent())?.includes("Open session") ? true : undefined,
    );
    const env = { METATOR_CONFIG_DIR: configDir };
    await metator(
      ["mrs", "triage", ID, "--thread", "T1", "--kind", "question", "--reply", "Cents: src/discount.ts:2."],
      repo.root,
      env,
    );
    await metator(
      ["mrs", "triage", ID, "--thread", "T2", "--kind", "change", "--state", "planned"],
      repo.root,
      env,
    );
    await until("the proposed reply", async () =>
      (await page.getByTestId("thread-T1").textContent())?.includes("proposed reply Cents")
        ? true
        : undefined,
    );
    await until("the planned thread", async () =>
      (await page.getByTestId("thread-T2").textContent())?.includes("planned · change") ? true : undefined,
    );
    expect(await page.getByTestId("send-replies").textContent()).toBe("Send 1 reply");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "17-open-mrs.png") });
    // Without a name nothing is sent: the app asks for it in its own dialog, once.
    await page.getByTestId("send-replies").click();
    const who = page.getByRole("dialog", { name: "your name" });
    await who.waitFor({ timeout: 5000 });
    await who.getByRole("button", { name: "Cancel" }).click();
    await Bun.sleep(500);
    expect(existsSync(repo.path("mcp.log"))).toBe(false);
    await page.getByTestId("send-replies").click();
    await who.getByLabel("Your name").fill("maciej");
    await who.getByRole("button", { name: "Save" }).click();
    await until("the reply sent", async () =>
      (await page.getByTestId("thread-T1").textContent())?.includes("answered") ? true : undefined,
    );
    expect(JSON.parse((await Bun.file(repo.path("mcp.log")).text()).trim())).toEqual({
      reply: 101,
      pull: 45,
      body: "Cents: src/discount.ts:2.",
    });
    await until("nothing left to send", async () =>
      (await page.getByTestId("send-replies").textContent()) === "Send 0 replies" ? true : undefined,
    );
    expect(errors).toEqual([]);
  }, 120_000);
});
