/**
 * A run its conductor moves on, in the desktop app: the conductor's pane lives, it asks nothing a
 * person must answer (its line ends in no question), no drive works in the background and nobody
 * holds the keyboard. Without a word the run would look stuck; the run's page says that the
 * conductor moves it on and offers its terminal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
/** Where a screenshot of the state is kept when METATOR_SHOTS names a directory. */
const SHOTS = process.env.METATOR_SHOTS;
const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
// The conductor says what it does and waits for a word on its own terminal: no question mark,
// so the screen is no prompt a person must answer.
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-orchestrator:
    - - say: "I am the conductor of this run. I delegate the build to a worker and collect its result."
      - ask: { question: "Type here to talk to the conductor.", options: [go on] }
`;
const NOWHERE = {
  METATOR_COPILOT_BIN: "/nonexistent/copilot",
  METATOR_CLAUDE_BIN: "/nonexistent/claude",
  METATOR_OPENCODE_BIN: "/nonexistent/opencode",
};

let repo: ScratchRepo;
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
let daemon: Bun.Subprocess<"ignore", "ignore", "pipe">;
let base = "";
let env: Record<string, string>;
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

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-conductor-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-conductor-config-"));
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = {
    ...NOWHERE,
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    METATOR_CONFIG_DIR: configDir,
  };
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: repo.root,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
    stdout: "ignore",
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
  const b = await browser();
  page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
}, 120_000);

afterAll(async () => {
  await closeBrowser();
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  // The conductors the test started work in the repository: nothing outlives the test.
  stopProcessesUnder(repo.root);
  site.stop(true);
  await repo.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("a run its conductor moves on (real daemon, real Chromium)", () => {
  test("the run's page says the conductor moves it on, and opens its terminal", async () => {
    const init = await metator(
      ["run", "init", "--workflow", "demo", "--task", "Round the totals"],
      repo.root,
      env,
    );
    const runId = (init.json.data as { runId: string }).runId;
    await metator(["run", "start", "--run", runId], repo.root, env);
    await page.goto(app(`run/${runId}/overview`));
    const bar = page.getByTestId("conductor-moves");
    await bar.waitFor({ timeout: 30_000 });
    expect(await bar.textContent()).toContain(
      "The conductor moves this run on at build: talk to it in its terminal.",
    );
    // Nothing else claims the run: no start bar, nothing in Needs you.
    expect(await page.getByTestId(`start-${runId}`).count()).toBe(0);
    expect(await page.getByTestId("needs-count").textContent()).toContain("Needs you · 0");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "conductor-moves-run.png") });
    await bar.getByRole("button", { name: "Open the terminal" }).click();
    await until("the terminal tab", async () =>
      page.url().includes(`#/run/${runId}/terminal`) ? true : undefined,
    );
    // On the terminal tab the bar stays, without the button that would lead where the person is.
    await until("the bar without its button", async () =>
      (await page.getByTestId("conductor-moves").getByRole("button").count()) === 0 ? true : undefined,
    );
    await metator(
      ["run", "close", "--run", runId, "--aborted", "--reason", "the test ends here"],
      repo.root,
      env,
    );
    await until("the bar gone", async () =>
      (await page.getByTestId("conductor-moves").count()) === 0 ? true : undefined,
    );
    expect(errors.filter((e) => !/Notification|favicon/.test(e))).toEqual([]);
  }, 90_000);
});
