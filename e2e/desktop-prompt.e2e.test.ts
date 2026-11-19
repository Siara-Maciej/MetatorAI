/**
 * A question an agent asks on its terminal, in the desktop app (round 4): the real daemon with its
 * supervisor reads the question from the pane and puts it in the inbox as the agent's, with the
 * answers it offered and the way into the pane. The app shows it as a TERMINAL question with who
 * asks and where; "Attach and answer in the pane" lands on the run's Terminal tab with that pane
 * focused and the keyboard taken; an offered answer chosen on the card is typed there by the daemon.
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
const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
// Each start of the conductor plays the next entry: two runs, two questions on the terminal.
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-orchestrator:
    - - say: "conducting"
      - ask: { question: "Which currency does a product without one get?", options: [PLN, EUR] }
      - say: "STATUS: done"
    - - say: "conducting again"
      - ask: { question: "Which rounding?", options: [half-up, half-even] }
      - say: "STATUS: done"
`;
/** No real AI host is reachable from this test: only the scenario host answers. */
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
const api = async (path: string) =>
  (await fetch(`${base}${path}`)).json() as Promise<{ ok: boolean; data: Record<string, unknown> }>;
type Decision = { runId: string; question: { id: string; source: string; prompt: string } };
const decisionOf = async (runId: string, id?: string) =>
  ((await api("/inbox")).data.decisions as Decision[]).find(
    (d) => d.runId === runId && (id === undefined || d.question.id === id),
  );
/** The activity of a run, as its lines. */
const activity = async (runId: string) =>
  ((await api(`/runs/${runId}/activity`)).data.entries as { text: string }[]).map((e) => e.text);

/** A run of the demo workflow whose conductor is started in a pane (it asks on its terminal). */
async function startRun(task: string): Promise<string> {
  const init = await metator(["run", "init", "--workflow", "demo", "--task", task], repo.root, env);
  const runId = (init.json.data as { runId: string }).runId;
  await metator(["run", "start", "--run", runId], repo.root, env);
  return runId;
}

/** The name dialog, the first time the app needs a name. */
async function nameIfAsked(): Promise<void> {
  const named = page.getByRole("dialog", { name: "your name" });
  if (
    await named.waitFor({ timeout: 3000 }).then(
      () => true,
      () => false,
    )
  ) {
    await named.getByLabel("Your name").fill("ana");
    await named.getByRole("button", { name: "Save" }).click();
  }
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-prompt-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-prompt-config-"));
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
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "200"],
    {
      cwd: repo.root,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
      stdout: "ignore",
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

describe("a question on an agent's terminal, in the app (real daemon, real Chromium)", () => {
  test("the card shows the question, who asks and its answers; Attach lands on the focused pane, holding the keyboard", async () => {
    const runId = await startRun("Add the currency");
    const asked = await until("the prompt in the inbox", () => decisionOf(runId));
    expect(asked.question.source).toBe("agent");
    await page.goto(app("inbox"));
    const card = page.getByRole("article", { name: "decision card" });
    await card.waitFor({ timeout: 20_000 });
    // The question itself; a terminal question, not a permission; who asks and in which pane.
    expect(await card.locator("h1").textContent()).toBe("Which currency does a product without one get?");
    expect(await card.locator(".ctx").textContent()).toContain("TERMINAL");
    expect(await card.getByTestId("host-asker").textContent()).toContain(
      "mt-orchestrator asks on its terminal",
    );
    // Which pane is an id: it is in the card's Details, with the run's.
    expect(await card.getByTestId("card-details").locator(".ctx").textContent()).toContain("pane w1:p1");
    expect(await card.locator(".option .label > span:first-child").allTextContents()).toEqual([
      "PLN",
      "EUR",
      "Attach and answer in the pane",
      "Other",
    ]);
    // Attach and answer in the pane: the run's Terminal tab, that pane, the keyboard taken, focused.
    await card.locator(".option", { hasText: "Attach and answer in the pane" }).click();
    await card.getByRole("button", { name: /^Attach and answer in the pane ⏎/ }).click();
    await nameIfAsked();
    await until("the run's terminal tab", async () =>
      page.url().includes(`#/run/${runId}/terminal/w1%3Ap1`) ||
      page.url().includes(`#/run/${runId}/terminal/w1:p1`)
        ? true
        : undefined,
    );
    await until("the keyboard taken", async () =>
      (await page.getByTestId("driverbar").textContent())?.includes("ana") ? true : undefined,
    );
    await until("the terminal focused", async () =>
      (await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[data-testid^="terminal-"], [data-testid^="pane-"]')),
      ))
        ? true
        : undefined,
    );
    // The focus is in the pane: what the person types is the answer.
    await page.keyboard.type("PLN");
    await page.keyboard.press("Enter");
    await until("the item closed by the answer in the pane", async () =>
      (await decisionOf(runId, asked.question.id)) ? undefined : true,
    );
    expect(
      (await activity(runId)).some((t) =>
        t.startsWith(`${asked.question.id}: Attach and answer in the pane · ana`),
      ),
    ).toBe(true);
    await metator(
      ["run", "close", "--run", runId, "--aborted", "--reason", "the test ends here"],
      repo.root,
      env,
    );
  }, 90_000);

  test("an answer the agent offered, clicked on the card, is typed in the pane under the person's name", async () => {
    const runId = await startRun("Round the totals");
    const asked = await until("the prompt in the inbox", () => decisionOf(runId));
    await page.goto(app("inbox"));
    const card = page.getByRole("article", { name: "decision card" });
    // The run's own card (alone, this test plays the scenario's first question).
    await until("the card of this run", async () =>
      (await card.locator(".ctx").textContent())?.includes(runId) ? true : undefined,
    );
    // The first offered answer is chosen already: the main button sends it; the daemon types it.
    const answer = (await card.locator(".option .label > span:first-child").first().textContent()) ?? "";
    await card.getByRole("button", { name: new RegExp(`^${answer} ⏎`) }).click();
    await nameIfAsked();
    await until("the item closed by the typed answer", async () =>
      (await decisionOf(runId, asked.question.id)) ? undefined : true,
    );
    const lines = await activity(runId);
    expect(lines.some((t) => t.startsWith(`${asked.question.id}: ${answer} · ana`))).toBe(true);
    // Nobody took the keyboard: the agent drives on.
    expect(lines).not.toContain("ana attached: the keyboard is theirs; approvals from the chat count");
    await metator(
      ["run", "close", "--run", runId, "--aborted", "--reason", "the test ends here"],
      repo.root,
      env,
    );
    expect(errors.filter((e) => !/Notification|favicon/.test(e))).toEqual([]);
  }, 90_000);
});
