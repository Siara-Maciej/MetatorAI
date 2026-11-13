/**
 * The desktop app end to end (D7, ADR-0078): the built app in a real Chromium over the real
 * daemon. A session is created from the dialog and driven on the scenario host; its gate
 * question reaches the inbox and is answered from the card (what 11a counts); the session screen
 * streams the PTY and lets the attached person type; the other screens render from the same state.
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
const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: build
    owner: mt-implementer
  - id: approval
    hitl: true
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  session:
    - - say: "hello from the session"
      - ask: { question: "Which rounding?", options: [half-up, half-even] }
      - say: "STATUS: done"
  mt-implementer:
    - - ask: { question: "Which currencies to support?", options: [PLN, EUR, USD], multiSelect: true }
      - say: "STATUS: done"
  mt-orchestrator:
    - - say: "Ask about the repository, or describe a task and I start the run."
      - ask: { question: "What do you need?", options: [a question, a task] }
      - say: "src/invoice.ts:1 total() sums the lines; the discount is not applied there."
`;

let repo: ScratchRepo;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
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
const api = async (path: string) =>
  (await fetch(`${daemonUrl}${path}`)).json() as Promise<{ ok: boolean; data: Record<string, unknown> }>;

beforeAll(async () => {
  // The app, built once.
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-"));
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
  // The daemon on a scratch repository with the scenario host; the person's options in a temp dir.
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-config-"));
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  // The entry point opens its pane on the first host of `hostOrder` (as the form would pick).
  await repo.write(
    "metator.config.yml",
    "kind: MetatorConfig\nschemaVersion: 9\nsupervisor:\n  hostOrder: [scenario]\n",
  );
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  // A second workflow, later in the alphabet, that runs at one level only (the form starts there).
  await repo.write(
    ".github/metator/workflows/mt-feature.yml",
    `${WORKFLOW.replace("id: demo", "id: mt-feature")}autonomy: [L0]\n`,
  );
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: repo.root,
    env: {
      ...process.env,
      METATOR_STATE_DIR: E2E_STATE_DIR,
      METATOR_CONFIG_DIR: configDir,
      METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
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
  page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  // The stack names the code that threw; on CI it is the only trace of a page error.
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/inbox`);
}, 120_000);

afterAll(async () => {
  await closeBrowser();
  daemon.kill("SIGTERM");
  await daemon.exited;
  site.stop(true);
  await repo.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("MetatorAI Desktop (real daemon, real Chromium)", () => {
  test("+ New session opens a pane with the agent as the entry point (T1); the form sits under Advanced", async () => {
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    await expect(page.getByText("Inbox zero")).toBeTruthy();
    await page.getByRole("button", { name: "+ New session" }).click();
    const workbench = page.getByTestId("workbench");
    const intake = workbench.locator('.pane-frame[aria-label^="chat"]').first();
    await intake.waitFor({ timeout: 20_000 });
    await until("the agent's greeting", async () =>
      (await intake.textContent())?.includes("describe a task and I start the run") ? true : undefined,
    );
    // The pane belongs to the "chat" workspace, not to a run; the host got the entry-point prompt.
    const layout = (await api("/layout")).data as {
      workspaces: { id: string; label: string; runId?: string }[];
      panes: { id: string; role: string; label: string; runId?: string; process: { prompt?: string } }[];
    };
    const pane = layout.panes.find((p) => p.label === "chat");
    expect(pane).toMatchObject({ role: "apps" });
    expect(pane?.runId).toBeUndefined();
    expect(pane?.process.prompt).toContain("entry point");
    expect(layout.workspaces.find((w) => w.label === "chat")?.runId).toBeUndefined();
    // A second click reuses the workspace: one "chat" workspace, two panes.
    await page.getByRole("button", { name: "+ New session" }).click();
    await until("the second pane", async () => {
      const l = (await api("/layout")).data as {
        panes: { label: string }[];
        workspaces: { label: string }[];
      };
      return l.panes.filter((p) => p.label === "chat").length === 2 ? l : undefined;
    });
    const again = (await api("/layout")).data as { workspaces: { label: string }[] };
    expect(again.workspaces.filter((w) => w.label === "chat")).toHaveLength(1);
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/inbox`);
    await page.getByTestId("connection").waitFor({ timeout: 20_000 });
  }, 60_000);

  test("connects, shows inbox zero, and creates a driven session from the dialog", async () => {
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    // `?` lists the keys on every screen: the app's own, and the workbench's with the real prefix key.
    await page.locator("main.content").click();
    await page.keyboard.press("?");
    const help = page.getByRole("dialog", { name: "keyboard help" });
    await help.waitFor({ timeout: 5000 });
    expect(await help.getByTestId("help-workbench").textContent()).toContain("ctrl+b zZoom");
    expect(await help.getByTestId("help-workbench").textContent()).not.toContain("prefix+");
    await page.keyboard.press("Escape");
    await until("the help closed", async () => ((await help.count()) === 0 ? true : undefined));
    await page.getByRole("button", { name: "Advanced…" }).click();
    const dialog = page.getByRole("dialog", { name: "new session" });
    await dialog.getByLabel("Task").fill("Add the discount to the invoice");
    await dialog.getByLabel("AI host").selectOption("scenario");
    await dialog.getByLabel("Worktree").uncheck();
    // The form starts at mt-feature, not at the first workflow of the alphabet, and offers only the
    // levels that workflow runs at, with words beside them.
    expect(await dialog.getByLabel(/^Workflow/).inputValue()).toBe("mt-feature");
    expect(await dialog.getByLabel("Autonomy").locator("option").allTextContents()).toEqual([
      "L0: every approval waits for you",
    ]);
    await dialog.getByLabel(/^Workflow/).selectOption("demo");
    await until("the levels of demo", async () =>
      (await dialog.getByLabel("Autonomy").locator("option").count()) === 2 ? true : undefined,
    );
    expect(await dialog.getByLabel("Autonomy").locator("option").allTextContents()).toEqual([
      "L0: every approval waits for you",
      "L1: skips the approvals the workflow lets it skip",
    ]);
    // Escape closes the dialog from a focused field (D7); it opens again with the same form.
    await dialog.getByLabel("Task").focus();
    await page.keyboard.press("Escape");
    await until("the dialog closed", async () => ((await dialog.count()) === 0 ? true : undefined));
    await page.getByRole("button", { name: "Advanced…" }).click();
    await dialog.getByLabel(/^Workflow/).selectOption("demo");
    await dialog.getByLabel("Task").fill("Add the discount to the invoice");
    await dialog.getByLabel("AI host").selectOption("scenario");
    await dialog.getByLabel("Worktree").uncheck();
    await expect(await dialog.locator("code").textContent()).toContain(
      "metator run init --workflow demo --task",
    );
    await dialog.getByRole("button", { name: "Create in background" }).click();
    const state = await until("the run", async () => {
      const s = await api("/state");
      const runs = s.data.runs as { runId: string }[];
      return runs.length > 0 ? runs : undefined;
    });
    expect(state[0]?.runId).toMatch(/-demo-/);
  }, 60_000);

  test("a multi-select question takes several choices; the name is asked for once, in the app's own dialog", async () => {
    const item = page.locator(".needs .item").first();
    await item.waitFor({ timeout: 40_000 });
    await expect(await item.locator(".kind").textContent()).toBe("QUESTION");
    const card = page.getByLabel("decision card");
    await expect(await card.locator("h1").textContent()).toContain("Which currencies");
    // Nothing is chosen for the person: the button waits for a choice.
    expect(await card.locator('.option[aria-pressed="true"]').count()).toBe(0);
    expect(await card.locator(".actions .primary").isDisabled()).toBe(true);
    await card.locator(".option", { hasText: "EUR" }).click();
    await card.locator(".option", { hasText: "USD" }).click();
    expect(await card.locator('.option[aria-pressed="true"] .label').allTextContents()).toEqual([
      "EUR",
      "USD",
    ]);
    await expect(await card.locator(".footer-cmd").textContent()).toContain("--choice EUR USD --by <you>");
    // No name yet: the answer waits for the dialog; a cancelled dialog sends nothing.
    await card.locator(".actions .primary").click();
    const who = page.getByRole("dialog", { name: "your name" });
    await who.waitFor({ timeout: 5000 });
    await who.getByRole("button", { name: "Cancel" }).click();
    expect(await page.locator(".needs .item").count()).toBe(1);
    await card.locator(".actions .primary").click();
    await who.getByLabel("Your name").fill("maciej");
    await who.getByRole("button", { name: "Save" }).click();
    const runId = ((await api("/state")).data.runs as { runId: string }[])[0]?.runId as string;
    const answer = await until("the answer", async () => {
      const entries = (await api(`/runs/${runId}/activity`)).data.entries as { type: string; text: string }[];
      return entries.find((e) => e.type === "answer");
    });
    expect(answer.text).toContain("EUR, USD · maciej");
    // The name stays: the top bar shows it and nothing asks again.
    expect(await page.locator(".topbar .who").textContent()).toBe("you: maciej");
  }, 60_000);

  test("the gate question arrives in the inbox and is answered from the card without opening the session", async () => {
    const item = page.locator(".needs .item", { hasText: "approval" }).first();
    await item.waitFor({ timeout: 40_000 });
    await expect(await item.locator(".kind").textContent()).toBe("APPROVAL");
    const card = page.getByLabel("decision card");
    await expect(await card.locator("h1").textContent()).toContain("approval");
    // Reject promises a reason (D8): without it neither the button nor Enter sends the answer.
    await card.locator(".option", { hasText: "Reject" }).click();
    expect(await card.locator(".reason span").textContent()).toBe("Reason for Reject (required)");
    expect(await card.locator(".actions .primary").isDisabled()).toBe(true);
    await card.locator("h1").click();
    await page.keyboard.press("Enter");
    await card.getByLabel("reason (required)").fill("the cap is in cents");
    expect(await card.locator(".actions .primary").isDisabled()).toBe(false);
    await expect(await card.locator(".footer-cmd").textContent()).toContain(
      '--choice Reject --text "the cap is in cents" --by maciej',
    );
    expect(await page.locator(".needs .item", { hasText: "approval" }).count()).toBe(1);
    await card.getByLabel("reason (required)").fill("");
    await card.locator(".option", { hasText: "Approve" }).click();
    // The footer is the command that does what the button does: the answer to the gate's question.
    const runOfCard = ((await api("/state")).data.runs as { runId: string }[])[0]?.runId as string;
    await expect(await card.locator(".footer-cmd").textContent()).toMatch(
      new RegExp(`metator run answer q\\d+ --run ${runOfCard} --choice Approve --by maciej`),
    );
    // The ⏎ on the button is a key: Enter outside a field sends the selected answer.
    await card.locator("h1").click();
    await page.keyboard.press("Enter");
    await until("the inbox to empty", async () =>
      (await page.locator(".needs .item").count()) === 0 ? true : undefined,
    );
    const runId = ((await api("/state")).data.runs as { runId: string }[])[0]?.runId as string;
    const activity = (await api(`/runs/${runId}/activity`)).data.entries as {
      type: string;
      origin?: string;
      text: string;
    }[];
    const answer = activity.filter((e) => e.type === "answer").at(-1);
    expect([answer?.origin, answer?.text]).toEqual(["inbox", expect.stringContaining("Approve · maciej")]);
    await until("the run to finish", async () => {
      const runs = (await api("/state")).data.runs as { status: string }[];
      return runs[0]?.status === "done" ? true : undefined;
    });
  }, 60_000);

  test("the session screen streams the PTY; only the attached person types; other screens render", async () => {
    // A second run, undriven: its scenario session is opened by the person, with "Open a session".
    const created = await (
      await fetch(`${daemonUrl}/runs`, {
        method: "POST",
        body: JSON.stringify({ workflow: "demo", task: "Round the totals" }),
      })
    ).json();
    const runId = (created as { data: { run: { runId: string } } }).data.run.runId;
    await page.goto(
      `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/session/${runId}`,
    );
    const term = page.getByTestId(`terminal-${runId}`);
    // Coming to the session starts nothing: the screen says no session runs, and the daemon has no pane.
    await page.getByTestId("no-session").waitFor({ timeout: 20_000 });
    await Bun.sleep(1500);
    expect(
      ((await api("/layout")).data.panes as { runId?: string }[]).filter((p) => p.runId === runId),
    ).toEqual([]);
    expect(await term.count()).toBe(0);
    await page.getByRole("button", { name: "Open a session" }).click();
    await term.waitFor({ timeout: 20_000 });
    await until("the session to greet", async () =>
      (await term.textContent())?.includes("hello from the session") ? true : undefined,
    );
    await expect(await page.getByTestId("driverbar").textContent()).toContain("Working: agent");
    // The agent asks on its own screen (D2): the run counts as waiting for you, in the top bar,
    // in the panel and on the session, and the Inbox has a row that opens the pane.
    await page.getByTestId("terminal-ask").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("counters").textContent()).toContain("need you 1");
    expect(await page.locator(".sessions .row[aria-current='true']").textContent()).toContain(
      "asks in its terminal",
    );
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/inbox`);
    const asks = page.getByTestId(`terminal-ask-${runId}`);
    await asks.waitFor({ timeout: 20_000 });
    expect(await asks.textContent()).toContain("answers in its terminal");
    expect(await page.locator("main.content").textContent()).not.toContain("Inbox zero");
    await asks.click();
    await term.waitFor({ timeout: 20_000 });
    expect(page.url()).toContain(`#/session/${runId}/`);
    // A single-letter shortcut is the bare key (D7): Ctrl+A is not "attach".
    await page.locator(".session .head").click();
    await page.keyboard.press("Control+a");
    await Bun.sleep(300);
    await expect(await page.getByTestId("driverbar").textContent()).toContain("Working: agent");
    await page.getByRole("button", { name: "Attach · a" }).click();
    await until("the lock", async () =>
      (await page.getByTestId("driverbar").textContent())?.includes("maciej") ? true : undefined,
    );
    // The scenario asks before it reads: send the answer once the question is on the screen.
    await until("the question on the screen", async () =>
      (await term.textContent())?.includes("Which rounding?") ? true : undefined,
    );
    expect(await page.getByTestId("terminal-ask").textContent()).toContain("type your answer there");
    await page.getByLabel("message to the session").fill("half-up");
    await page.getByRole("button", { name: "Send" }).click();
    await until("the answer echoed", async () =>
      (await term.textContent())?.includes("answer: half-up") ? true : undefined,
    );
    // The run's panes (R4): the conductor's tab with its state; a shell pane opens, streams and closes.
    const panes = page.getByTestId("panes");
    await until("the conductor's tab", async () =>
      (await panes.textContent())?.includes("agent · ") ? true : undefined,
    );
    await panes.getByRole("button", { name: "+ Shell" }).click();
    const shellTerm = page.locator('[data-testid^="pane-"]');
    await shellTerm.first().waitFor({ timeout: 20_000 });
    await until("the panel's pane rows", async () =>
      (await page.locator(".sessions .pane-row").count()) >= 2 ? true : undefined,
    );
    await until("the shell tab", async () =>
      (await panes.textContent())?.includes("shell") ? true : undefined,
    );
    await panes.getByTitle(/^close w\d+:p\d+$/).click();
    await until("the shell tab gone", async () =>
      (await panes.textContent())?.includes("shell") ? undefined : true,
    );
    await page.getByRole("tab", { name: /Events/ }).click();
    await until("the events table", async () =>
      (await page.locator(".events tbody tr").count()) > 0 ? true : undefined,
    );
    // The workbench (S6): the run is a tab, its stages a strip, its conductor a framed pane.
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/grid`);
    const workbench = page.getByTestId("workbench");
    await workbench.locator(".pane-frame").first().waitFor({ timeout: 20_000 });
    await until("the run's tab", async () =>
      (await workbench.locator(".tabbar").textContent())?.includes("Round the totals") ? true : undefined,
    );
    expect(await page.getByTestId("procstrip").textContent()).toContain("build");
    // prefix+v splits the focused pane: a shell beside it, in the daemon's tree.
    await page.mouse.click(700, 400);
    await page.keyboard.press("Control+b");
    // While the prefix waits for its key the tab bar shows the key itself, not the word "prefix".
    expect(await page.getByTestId("prefix").textContent()).toContain("ctrl+b");
    await page.keyboard.press("v");
    await until("two frames", async () =>
      (await workbench.locator(".pane-frame").count()) === 2 ? true : undefined,
    );
    const layout = (await api("/layout")).data as { workspaces: { tabs: { tree?: unknown }[] }[] };
    expect(layout.workspaces.some((w) => w.tabs.some((t) => t.tree !== undefined))).toBe(true);
    // The new shell takes anyone's keys: typed text comes back from the PTY.
    const shellFrame = workbench.locator('.pane-frame:not([aria-label^="agent · "])').first();
    await shellFrame.waitFor({ timeout: 20_000 });
    await shellFrame.locator(".xterm").click();
    await page.keyboard.type("echo hello-from-the-workbench");
    await page.keyboard.press("Enter");
    await until("the echo", async () =>
      (await shellFrame.textContent())?.includes("hello-from-the-workbench") ? true : undefined,
    );
    // Leaving the workbench while a pane still streams must not leave an error behind: xterm's
    // pending frames run after the terminal is gone.
    for (let i = 0; i < 3; i++) {
      await shellFrame.locator(".xterm").click();
      await page.keyboard.type("seq 1 400");
      await page.keyboard.press("Enter");
      await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/inbox`);
      await page.getByTestId("connection").waitFor({ timeout: 20_000 });
      await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/grid`);
      await shellFrame.waitFor({ timeout: 20_000 });
    }
    // prefix+z zooms the focused pane and back; prefix+g opens the go-to picker.
    await page.keyboard.press("Control+b");
    await page.keyboard.press("z");
    await workbench.locator(".split.zoomed").waitFor({ timeout: 5000 });
    await page.keyboard.press("Control+b");
    await page.keyboard.press("z");
    await until("unzoomed", async () =>
      (await workbench.locator(".split.zoomed").count()) === 0 ? true : undefined,
    );
    await page.keyboard.press("Control+b");
    await page.keyboard.press("g");
    const picker = page.getByRole("dialog", { name: "Go to" });
    await picker.waitFor({ timeout: 5000 });
    expect(await picker.textContent()).toContain("agent · ");
    await page.keyboard.press("Escape");
    await until("the picker closed", async () => ((await picker.count()) === 0 ? true : undefined));
    // A right click on a pane is the menu with the splits.
    await shellFrame.click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor({ timeout: 5000 });
    expect(await menu.textContent()).toContain("Split right");
    // A menu item shows its key as it is pressed.
    expect(await menu.textContent()).toContain("ctrl+b v");
    // A shell at its prompt is idle on every screen: never "waiting", never "working".
    await until("the idle shell", async () =>
      (await shellFrame.getAttribute("data-state")) === "idle" ? true : undefined,
    );
    expect(
      await workbench.locator(".sidebar .ag").filter({ hasNotText: "agent ·" }).first().textContent(),
    ).toContain("idle");
    await page.keyboard.press("Escape");
    // "New task from here…" opens the backlog's form with the pane's run as what the task points at.
    await workbench.locator('.pane-frame[aria-label^="agent · "]').first().click({ button: "right" });
    await page.getByRole("menu").getByText("New task from here…").click();
    await page.getByTestId("backlog").waitFor({ timeout: 20_000 });
    await until("the draft in the form", async () =>
      (await page.getByTestId("backlog").textContent())?.includes(`points at: run ${runId}`)
        ? true
        : undefined,
    );
    // Left and opened again, the backlog has no draft: the form is closed.
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/grid`);
    await shellFrame.waitFor({ timeout: 20_000 });
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/backlog`);
    await page.getByTestId("backlog").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("backlog").textContent()).not.toContain("points at:");
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/grid`);
    await shellFrame.waitFor({ timeout: 20_000 });
    // A key rebound in the options works at once: keys.zoom → prefix+f.
    await fetch(`${daemonUrl}/options/keys.zoom`, {
      method: "POST",
      body: JSON.stringify({ scope: "user", value: ["prefix+f"] }),
      headers: { "content-type": "application/json" },
    });
    await until(
      "the app to read the new key",
      async () => ((await workbench.getAttribute("data-zoom-key")) === "prefix+f" ? true : undefined),
      20_000,
    );
    await page.keyboard.press("Control+b");
    await page.keyboard.press("f");
    await workbench.locator(".split.zoomed").waitFor({ timeout: 5000 });
    // The plan (S2): the run's stages and what waits, from the board.
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/plan/${runId}`);
    await page.getByTestId("plan").waitFor({ timeout: 20_000 });
    await until("the plan's stages", async () =>
      (await page.getByTestId("plan-stages").textContent())?.includes("build") ? true : undefined,
    );
    expect(await page.getByTestId("plan").textContent()).toContain("no plan yet");
    // The backlog (S4): a task added from the form is open; an agent's proposal waits for the decision.
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/backlog`);
    await page.getByTestId("backlog").waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "+ task" }).click();
    await page.getByLabel("title").fill("Flaky checkout.spec");
    await page.getByLabel("what and why").fill("Fails one run in five.");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByTestId("issue-i001").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("backlog").textContent()).toContain("i001 · open");
    // A run on the task starts on a workflow this repository has (D5), not on a guessed one.
    expect(await page.getByLabel("workflow").inputValue()).toBe("mt-feature");
    // What an action answered stays on the screen past the list's refresh (D5).
    await page.route("**/issues/i001/close*", (r) =>
      r.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { code: "USAGE", message: "the task is locked" } }),
      }),
    );
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.locator(".backlog .notice").waitFor({ timeout: 5000 });
    await Bun.sleep(4500);
    expect(await page.locator(".backlog .notice .msg").textContent()).toBe("the task is locked");
    await page.locator(".backlog .notice").getByLabel("dismiss").click();
    expect(await page.locator(".backlog .notice").count()).toBe(0);
    await page.unroute("**/issues/i001/close*");
    const proposed = Bun.spawnSync(
      [
        "bun",
        CLI_ENTRY,
        "issue",
        "propose",
        "Edge test 1000.00",
        "--agent",
        "mt-implementer-1",
        "--run",
        runId,
      ],
      { cwd: repo.root, env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR } },
    );
    expect(proposed.exitCode).toBe(0);
    await page.getByTestId("issue-i002").waitFor({ timeout: 20_000 });
    await page.getByTestId("issue-i002").click();
    expect(await page.getByTestId("backlog").textContent()).toContain("1 proposal waits for you");
    await page.getByRole("button", { name: "Drop", exact: true }).click();
    await until("the proposal dropped", async () =>
      (await page.getByTestId("backlog").textContent())?.includes("proposal waits") ? undefined : true,
    );
    expect(
      ((await api("/issues")).data.issues as { id: string; status: string }[]).map((i) => [i.id, i.status]),
    ).toEqual([
      ["i001", "open"],
      ["i002", "dropped"],
    ]);
    // The change (S5): a file written in the checkout shows as added with its lines; a note on a
    // line is a draft until "Send to agent" makes it one review message of the run.
    await Bun.write(
      join(repo.root, "src/discount.ts"),
      "export const discount = 0.1;\nexport const cap = 100;\n",
    );
    await page.goto(
      `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/review/${runId}`,
    );
    await page.getByTestId("review").waitFor({ timeout: 20_000 });
    await page.getByTestId("file-src/discount.ts").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("file-src/discount.ts").textContent()).toContain("+2");
    await page.getByTestId("file-src/discount.ts").click();
    await page.locator(".review .line.add").first().waitFor({ timeout: 20_000 });
    await page.locator(".review .line.add").nth(1).click();
    await page.getByLabel("note on line 2").fill("cap in cents?");
    await page.getByRole("button", { name: "Add note" }).click();
    await page.locator(".review .inline-note").waitFor({ timeout: 20_000 });
    await page.getByTestId("send-notes").click();
    await until("the note sent", async () =>
      (await page.locator(".review .inline-note.sent").count()) === 1 ? true : undefined,
    );
    const sentMessages = (await api(`/runs/${runId}/messages`)).data.messages as {
      topic: string;
      text: string;
    }[];
    expect(sentMessages.map((m) => m.topic)).toEqual(["review"]);
    expect(sentMessages[0]?.text).toContain("- src/discount.ts:2: cap in cents?");
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/graph`);
    await page.getByRole("img", { name: "runs graph" }).waitFor({ timeout: 20_000 });
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/supervisor`);
    await until("the KPI tiles", async () =>
      (await page.getByTestId("kpi-inbox").textContent())?.includes("100%") ? true : undefined,
    );
    // The tiles say what they count in plain words, and the hosts say whether they can start.
    expect(await page.getByTestId("kpi-inbox").textContent()).toContain(
      "answered from the card, without opening the session",
    );
    expect(await page.getByTestId("host-scenario").textContent()).toContain("installed");
    // Settings (D6): a refused value does not stay in the field, and the refusal stays on the screen.
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/settings`);
    await page.locator("#settings-q").fill("wipLimit");
    const limit = page.getByTestId("option-supervisor.wipLimit");
    await limit.waitFor({ timeout: 20_000 });
    await limit.locator("input").fill("-5");
    await limit.locator("input").blur();
    await page.locator(".settings-screen .notice").waitFor({ timeout: 5000 });
    await Bun.sleep(3500);
    expect(await limit.locator("input").inputValue()).toBe("4");
    expect(await page.locator(".settings-screen .notice .msg").textContent()).toContain(
      "supervisor.wipLimit was not changed",
    );
    await limit.locator("input").fill("7");
    await limit.locator("input").blur();
    await until("the limit set", async () =>
      (await limit.getAttribute("data-source")) === "repo" ? true : undefined,
    );
    await limit.getByRole("button", { name: "default" }).click();
    await until("the limit reset", async () =>
      (await limit.getAttribute("data-source")) === "default" ? true : undefined,
    );
    expect(await limit.locator("input").inputValue()).toBe("4");
    // A narrow window (D12): the sessions panel is a drawer behind a button of the top bar.
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto(`http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/inbox`);
    await page.getByTestId("connection").waitFor({ timeout: 20_000 });
    expect(await page.locator("aside.sessions").isVisible()).toBe(false);
    await page.getByRole("button", { name: /^Runs · / }).click();
    expect(await page.locator("aside.sessions").isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.locator("aside.sessions").isVisible()).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(daemonUrl)}#/briefing/${runId}`,
    );
    await page.getByRole("button", { name: "Mark as read" }).waitFor({ timeout: 20_000 });
    await until("the briefing", async () =>
      (await page.locator(".briefing h2").textContent())?.includes("Since you left") ? true : undefined,
    );
    // The two refusals this test provokes (the locked task, the refused setting) are 400s by design.
    expect(errors.filter((e) => !/Notification|favicon|status of 400/.test(e))).toEqual([]);
  }, 90_000);
});
