/**
 * My MRs in the Reviews place end to end (T3, round 18: ADR-0097): the built app in a real Chromium
 * over the real daemon, which reads my request's review through a real MCP server process (a
 * stand-in for GitHub; never a real code host). A new review starts nothing by itself: Home shows
 * "New review in MR #45 (2 threads)", whose Analyse opens the responder's terminal. The proposed
 * replies come with a checkbox each; "Send selected" posts only the checked ones, under my name.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
const FAKE = join(import.meta.dir, "helpers/fake-mcp-server.ts");
const ID = "github-acme-shop-45";
// Analyse opens the responder in a pane of its own: the scenario host says what it is and waits.
// No real AI host is ever started.
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-review-responder:
    - - say: "I am the review responder. I read the new threads."
      - run: 'sleep 300'
`;
/** Where a screenshot of the screen is kept when METATOR_SHOTS names a directory. */
const SHOTS = process.env.METATOR_SHOTS;

let repo: ScratchRepo;
let daemon: Bun.Subprocess<"ignore", "ignore", "pipe">;
let daemonUrl = "";
let dist: string;
let configDir: string;
let bin: string;
let env: Record<string, string>;
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
const text = async (testId: string) =>
  (await page
    .getByTestId(testId)
    .first()
    .textContent({ timeout: 1000 })
    .catch(() => "")) ?? "";
const says = (testId: string, words: string, ms?: number) =>
  until(
    `${testId} to say "${words}"`,
    async () => ((await text(testId)).includes(words) ? true : undefined),
    ms,
  );

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
  bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  chmodSync(join(bin, "metator"), 0o755);
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\npulls.json\nmcp.log\nscenario.yml\n");
  await repo.write("scenario.yml", SCENARIO);
  await repo.write("src/discount.ts", "export const discount = 0.1;\nexport const cap = 100;\n");
  await repo.write(
    "metator.config.yml",
    `kind: MetatorConfig
schemaVersion: 15
hosts:
  metatorCommand: ${join(bin, "metator")}
supervisor:
  hostOrder: [scenario]
mcp:
  github:
    command: bun
    args: ["${FAKE}"]
    env:
      FAKE_MCP_PULLS: "${repo.path("pulls.json")}"
      FAKE_MCP_LOG: "${repo.path("mcp.log")}"
codehost:
  sources:
    - { id: shop, kind: github, repo: acme/shop, via: "mcp:github", author: maciej }
reviews:
  everyMs: 1000
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
  env = {
    METATOR_CONFIG_DIR: configDir,
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    METATOR_NO_REAL_HOSTS: "1",
    METATOR_CLAUDE_BIN: "/nonexistent/claude",
    METATOR_COPILOT_BIN: "/nonexistent/copilot",
    METATOR_OPENCODE_BIN: "/nonexistent/opencode",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0", "--intake-ms", "0"],
    {
      cwd: repo.root,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const reader = daemon.stderr.getReader();
  let out = "";
  daemonUrl = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    out += new TextDecoder().decode(value);
    const line = out.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
  void (async () => {
    for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return;
  })();
  const b = await browser();
  page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
}, 180_000);

afterAll(async () => {
  await page?.close();
  await closeBrowser();
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  // The responder's pane works in the repository: nothing outlives it.
  stopProcessesUnder(repo.root);
  site?.stop(true);
  await repo?.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});

describe("MetatorAI Desktop: my MRs in Reviews (real daemon, real Chromium, real MCP server process)", () => {
  test("a new review is a card on Home; Analyse opens the responder's terminal, nothing starts by itself", async () => {
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/inbox`);
    // The daemon's own scan finds the review within its interval and leaves a card, not a run.
    const card = page.getByTestId("review-card-mine");
    await card.waitFor({ timeout: 40_000 });
    expect(await card.textContent()).toContain("New review in MR #45 (2 threads)");
    const runs = (await metator(["run", "list"], repo.root, env)).json.data as unknown[];
    expect(runs).toEqual([]);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "18-home-new-review.png") });
    await card.getByRole("button", { name: "Analyse" }).click();
    const who = page.getByRole("dialog", { name: "your name" });
    await who.waitFor({ timeout: 5000 });
    await who.getByLabel("Your name").fill("maciej");
    await who.getByRole("button", { name: "Save" }).click();
    // The responder's terminal shows at once.
    await until("the responder's terminal", async () =>
      page.url().includes("#/grid/pane:") ? true : undefined,
    );
    expect(errors).toEqual([]);
  }, 120_000);

  test("my MR in Reviews: a checkbox on each proposed reply, Send selected posts only the checked", async () => {
    // What the responder records, as it would from its pane.
    for (const [thread, reply] of [
      ["T1", "Cents: src/discount.ts:2."],
      ["T2", "Renamed to capCents."],
    ] as const)
      expect(
        (
          await metator(
            ["mrs", "triage", ID, "--thread", thread, "--kind", "question", "--reply", reply],
            repo.root,
            env,
          )
        ).code,
      ).toBe(0);
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/reviews/${ID}`);
    await page.getByTestId("reviews").waitFor({ timeout: 20_000 });
    // The place is in the sidebar, next to Backlog; Settings no longer holds it.
    const place = page.getByRole("navigation", { name: "places" }).getByRole("link", { name: "Reviews" });
    expect(await place.getAttribute("aria-current")).toBe("page");
    await says(`mr-${ID}`, "replies ready");
    expect(await text(`mr-${ID}`)).toContain("#45 Cap the discount");
    expect(await text(`mr-${ID}`)).toContain("2 replies to send");
    expect(await text(`mr-${ID}`)).not.toContain("github");
    expect(await text("thread-T1")).toContain("anna · src/discount.ts:2");
    expect(await text("thread-T1")).toContain("proposed reply Cents");
    expect(await page.getByTestId("send-T1").isChecked()).toBe(true);
    expect(await page.getByTestId("send-T2").isChecked()).toBe(true);
    expect(await text("send-replies")).toBe("Send selected (2)");
    await page.getByTestId("send-T2").uncheck();
    expect(await text("send-replies")).toBe("Send selected (1)");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "18-my-mr-send-selected.png") });
    await page.getByTestId("send-replies").click();
    await says("thread-T1", "answered");
    const sent = (await Bun.file(repo.path("mcp.log")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { reply?: number; body?: string })
      .filter((e) => e.reply !== undefined);
    expect(sent).toEqual([{ reply: 101, pull: 45, body: "Cents: src/discount.ts:2." } as never]);
    // The unchecked reply stays, to send later.
    expect(await text("thread-T2")).toContain("proposed reply Renamed");
    // It stays unchecked until the person checks it again.
    await says("send-replies", "Send selected (0)");
    expect(await page.getByTestId("send-replies").isDisabled()).toBe(true);
    await page.getByTestId("send-T2").check();
    expect(await text("send-replies")).toBe("Send selected (1)");
    expect(errors).toEqual([]);
  }, 120_000);
});
