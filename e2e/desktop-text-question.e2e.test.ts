/**
 * An agent's question in words, in the app (ADR-0091; real daemon, real Chromium, scenario host
 * only): a run's conductor ends its turn with numbered options and waits at its prompt, as Claude
 * Code did in a real run. Its frame in Terminals says "needs you"; Home shows the card with the
 * one-line prompt, the whole message on a click and the options; option 1 sent from the card is
 * typed into the pane, which reads it.
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
const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-orchestrator:
    - - say: "● The tests fail: the build has no currency field."
      - say: ""
      - say: "  Options:"
      - say: "  1. Add the field and run the tests again."
      - say: "  2. Stop the run."
      - run: 'read -r line; printf "answer: %s\\n" "$line"'
      - run: 'sleep 120'
`;

let repo: ScratchRepo;
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let runId = "";

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
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-text-question-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-text-question-config-"));
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  const env = {
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    METATOR_HOST: "scenario",
    METATOR_CONFIG_DIR: configDir,
  };
  runId = (
    (await metator(["run", "init", "--workflow", "demo", "--task", "Add the currency"], repo.root, env)).json
      .data as { runId: string }
  ).runId;
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "500"],
    {
      cwd: repo.root,
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

describe("an agent's question in words, in the app (real daemon, real Chromium)", () => {
  test("its frame needs you; Home lists it with no card and goes to the run's pane; the answer reaches the pane", async () => {
    await fetch(`${base}/runs/${runId}/pty-open`, { method: "POST", body: "{}" });
    await until("the question in the inbox", async () => {
      const r = (await (await fetch(`${base}/inbox`)).json()) as { data: { panes?: { paneId: string }[] } };
      return r.data.panes?.some((p) => p.paneId === "w1:p1") ? true : undefined;
    });
    await page.goto(app("grid/pane:w1:p1"));
    await page.getByTestId("needs-you-w1:p1").waitFor({ timeout: 30_000 });
    await page.goto(app("inbox"));
    const line = page.getByTestId("terminal-need-w1:p1");
    await line.waitFor({ timeout: 30_000 });
    expect(await line.textContent()).toContain("The tests fail: the build has no currency field.");
    expect(await page.locator("article.card").count()).toBe(0);
    // The line goes to the run's Terminal tab on the pane that asks.
    await line.click();
    await page.getByTestId("terminal-ask").waitFor({ timeout: 30_000 });
    expect(page.url()).toContain(`#/run/${runId}/terminal/${encodeURIComponent("w1:p1")}`);
    // The daemon types an answer into the pane (what `metator pane answer` does).
    const asked = (await (await fetch(`${base}/inbox`)).json()) as {
      data: { panes: { paneId: string; question: { id: string } }[] };
    };
    const question = asked.data.panes.find((x) => x.paneId === "w1:p1")?.question.id;
    await fetch(`${base}/panes/${encodeURIComponent("w1:p1")}/answer`, {
      method: "POST",
      body: JSON.stringify({ question, choices: ["1. Add the field and run the tests again."], by: "ana" }),
    });
    await until("the pane to read 1", async () => {
      const r = (await (await fetch(`${base}/panes/w1:p1`)).json()) as { data: { text: string } };
      return r.data.text.includes("answer: 1") ? true : undefined;
    });
    await page.goto(app("inbox"));
    await until("the line to go", async () => ((await line.count()) === 0 ? true : undefined));
    await metator(["run", "close", "--run", runId, "--aborted", "--reason", "the test ends it"], repo.root);
  }, 120_000);
});
