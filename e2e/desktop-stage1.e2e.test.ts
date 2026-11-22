/**
 * Stage 1 of the conversation agent in the app (round 13; real daemon, real Chromium, the scenario
 * host and, for the one screen only Claude Code draws, a stand-in `claude`; never a real AI host).
 * "+ New chat" opens the repository's conversation agent once `metator setup` installed it, with
 * the label "chat"; a chat's `git commit` waits as a consent card whose heading is the command;
 * a real `mt-quick` run (the engine's own scenario) asks its two cards: "This grew past quick"
 * (Keep as quick) and "Quick change ready" ("Open diff" opens the run's Changes and leaves the
 * card, "Fine" ends the run); "Debug changes (N)" lists and removes real scratch records, says
 * what could not be removed, and survives a count that is one too high. No browser fixture.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_APPROVAL_REAL_SCREEN } from "@metator/testing";
import type { Page } from "playwright";
import { browser, closeBrowser, decisionOnHome } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
const SHOTS = process.env.METATOR_SHOTS;
const QUICK = await Bun.file(join(ROOT, ".github/metator/workflows/mt-quick.yml")).text();
const CONFIG = `kind: MetatorConfig
schemaVersion: 13
supervisor:
  hostOrder: [scenario]
gates:
  quick:
    - id: check
      run: { script: check }
`;
// The quick run's conductor and worker, as in e2e/quick.e2e.test.ts: the implementer adds a source
// file no test reaches (the escalator the diff trips). Any other conductor, and the chat, only speak.
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-chat:
    - - say: "I am the chat. Tell me what you need."
      - run: 'sleep 300'
  mt-orchestrator:
    - - say: "conducting {cwd}"
      - run: 'case "$METATOR_RUN" in *round-prices*) ;; *) echo "another run: nothing scripted"; sleep 300;; esac'
      - run: 'metator run delegate build --run "$METATOR_RUN" --agent mt-implementer --card "Add a half-up rate helper in src/rate.ts"'
      - run: 'metator run wait mt-implementer-1 --run "$METATOR_RUN" --timeout 60000'
      - run: 'metator run collect mt-implementer-1 --run "$METATOR_RUN"'
      - run: 'metator run advance pass --run "$METATOR_RUN"'
      - run: 'metator gate quick --base HEAD'
      - run: 'metator run advance pass --run "$METATOR_RUN"'
      - run: 'metator quick check --diff'
      - run: 'metator quick fit --run "$METATOR_RUN" --wait 60000'
      - run: 'metator run advance pass --run "$METATOR_RUN"'
      - write: { path: "{runDir}/quick-review.md", text: "No blocking finding.\\n" }
      - run: 'metator run advance pass --run "$METATOR_RUN"'
      - run: 'metator quick ready --run "$METATOR_RUN" --wait 60000'
      - say: "quick run done"
      - run: 'sleep 300'
  mt-implementer:
    - - say: "rounding half-up"
      - write: { path: "{cwd}/src/rate.ts", text: "export const rate = (n: number) => Math.round(n);\\n" }
      - write: { path: "{runDir}/build-log.md", text: "rate.ts rounds half-up\\n" }
      - run: 'metator run result --run "$METATOR_RUN" --worker "$METATOR_WORKER" --status done --summary "rate.ts rounds half-up" --artifact build-log.md'
      - run: 'sleep 300'
`;
const PRICE = "export const price = (n: number) => n;\n";
const TAX = 'import { price } from "./price.ts";\nexport const tax = (n: number) => price(n) * 0.23;\n';
const COMMIT = 'git commit -m "Add the list of supported currencies"';
/** Claude Code's approval of a guarded command, as it draws it: the stand-in's whole screen. */
const APPROVAL = CLAUDE_APPROVAL_REAL_SCREEN.replaceAll("metator workflow list", COMMIT).replace(
  "List available workflows",
  "Commit the change",
);
let repo: ScratchRepo;
let dist: string;
let configDir: string;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let env: Record<string, string>;
let bin: string;
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
const api = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as { data: never };

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-stage1-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-stage1-config-"));
  bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  chmodSync(join(bin, "metator"), 0o755);
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nstandin/\nscenario.yml\n");
  await repo.write(
    "package.json",
    JSON.stringify({ name: "shop", private: true, scripts: { check: "true" } }),
  );
  await repo.write("metator.config.yml", CONFIG);
  await repo.write(".github/metator/workflows/mt-quick.yml", QUICK);
  await repo.write("src/price.ts", PRICE);
  await repo.write("src/tax.ts", TAX);
  await repo.write(
    "test/tax.test.ts",
    'import { tax } from "../src/tax.ts";\nif (tax(100) !== 23) throw new Error("tax");\n',
  );
  await repo.write("scenario.yml", SCENARIO);
  await repo.write("standin/approval.txt", `${APPROVAL}\n`);
  await repo.write(
    "standin/claude",
    `#!/bin/sh\ncat "${repo.path("standin/approval.txt")}"\nread -r key\nprintf 'picked %s\\n' "$key"\nsleep 60\n`,
  );
  chmodSync(repo.path("standin/claude"), 0o755);
  await repo.commit("init");
  env = {
    METATOR_CONFIG_DIR: configDir,
    METATOR_USER: "ana",
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    // Not a real host: a script that draws the one screen only Claude Code draws.
    METATOR_CLAUDE_BIN: repo.path("standin/claude"),
    METATOR_COPILOT_BIN: "/nonexistent/copilot",
    METATOR_OPENCODE_BIN: "/nonexistent/opencode",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
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
  stopProcessesUnder(repo.root);
  site?.stop(true);
  await repo?.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
}, 60_000);

async function nameIfAsked() {
  const who = page.getByRole("dialog", { name: "your name" });
  if (
    await who.waitFor({ timeout: 1500 }).then(
      () => true,
      () => false,
    )
  ) {
    await who.getByLabel("Your name").fill("ana");
    await who.getByRole("button", { name: "Save" }).click();
  }
}
type Pane = {
  id: string;
  label: string;
  role: string;
  runId?: string;
  process: { agent?: string; host?: string };
};
const panes = async () => ((await api("/layout")) as { data: { panes: Pane[] } }).data.panes;

const mt = (...args: string[]) => metator(args, repo.root, env);
const post = async (path: string, body: unknown) =>
  (await (await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) })).json()) as {
    ok: boolean;
    data: never;
  };
const stateOf = async () => ((await api("/state")) as { data: { scratch: number } }).data;
/** A debug edit as the chat's agent records it: begin, write the files, end with a note. */
async function scratchEdit(files: Record<string, string>, note?: string): Promise<string> {
  expect((await mt("scratch", "begin")).code).toBe(0);
  for (const [path, text] of Object.entries(files)) await repo.write(path, text);
  const ended = await mt("scratch", "end", ...(note ? ["--note", note] : []));
  return (ended.json.data as { recorded: { id: string } }).recorded.id;
}

describe("the conversation agent's first stage in the app (round 13)", () => {
  test("+ New chat opens the repository's conversation agent as the chat; a chat's commit waits as a consent card", async () => {
    await page.goto(app("inbox"));
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    // Before `metator setup` the repository has no conversation agent: the agent of before.
    expect(((await api("/supervisor")) as { data: { chatAgent?: string } }).data.chatAgent).toBeUndefined();
    await page.getByRole("button", { name: "+ New chat" }).click();
    await nameIfAsked();
    const first = await until("the chat pane", async () => (await panes())[0]);
    expect([first.label, first.role, first.process.agent]).toEqual(["chat", "apps", "mt-orchestrator"]);
    await post(`/panes/${first.id}/close`, {});
    await until("the pane closed", async () => ((await panes()).length === 0 ? true : undefined));
    // `metator setup` installs it: the daemon names it, and the chat opens it.
    expect((await mt("setup")).code).toBe(0);
    expect(await repo.exists(".claude/agents/mt-chat.md")).toBe(true);
    await repo.commit("metator setup");
    await page.goto(app("inbox"));
    await page.getByRole("button", { name: "+ New chat" }).click();
    await nameIfAsked();
    const chat = await until("the chat pane", async () => (await panes())[0]);
    expect([chat.label, chat.role, chat.process.agent, chat.process.host]).toEqual([
      "chat",
      "apps",
      "mt-chat",
      "scenario",
    ]);
    await until("the chat's screen", async () =>
      (
        await page
          .getByTestId(`frame-${chat.id}`)
          .textContent()
          .catch(() => "")
      )?.includes("I am the chat")
        ? true
        : undefined,
    );
    await post(`/panes/${chat.id}/close`, {});
    // A chat on Claude Code asks to commit (the stand-in draws the host's approval): the guard lets
    // the host ask, and that is a card on Home.
    const opened = await post("/panes", { label: "chat", role: "apps", host: "claude", agent: "mt-chat" });
    const asking = (opened.data as { id: string }).id;
    expect((await panes()).find((x) => x.id === asking)?.process.host).toBe("claude");
    await until("the stand-in's screen", async () => {
      const r = (await api(`/panes/${asking}`)) as { data: { text: string } };
      return r.data.text.includes("Do you want to proceed") ? true : undefined;
    }).catch(async (e) => {
      const r = (await api(`/panes/${asking}`)) as { data: unknown };
      throw new Error(`${(e as Error).message}: ${JSON.stringify(r.data).slice(0, 600)}`);
    });
    await page.goto(app("inbox"));
    const card = page.getByTestId(`pane-ask-${asking}`);
    await card.waitFor({ timeout: 30_000 });
    // Its heading is the command; the card says the command needs the person's consent.
    expect(await card.locator("h1").textContent()).toBe(COMMIT);
    expect(await card.getByTestId("consent").textContent()).toBe(
      "git commit needs your consent: it runs only when you say Yes here, or ask for it in the chat. MetatorAI never does it by itself.",
    );
    expect((await card.locator(".option .label").allTextContents())[0]).toBe("Yes");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "consent-card.png") });
    // Yes from the card is the consent: the host's menu gets its 1.
    await card.getByRole("radio").first().check();
    await card.getByRole("button", { name: "Send" }).click();
    await nameIfAsked();
    await until("the pane to pick 1", async () => {
      const r = (await api(`/panes/${asking}`)) as { data: { text: string } };
      return r.data.text.includes("picked 1") ? true : undefined;
    });
    await until("the card to go", async () => ((await card.count()) === 0 ? true : undefined));
    await post(`/panes/${asking}/close`, {});
  }, 120_000);

  test("a real quick run's two cards: Keep as quick, then Open diff opens the change and leaves the card, Fine ends the run", async () => {
    const started = await mt("quick", "start", "--task", "Round prices half-up");
    expect([started.code, started.json.error ?? null]).toEqual([0, null]);
    const runId = (started.json.data as { runId: string }).runId;
    expect(runId).toContain("mt-quick");
    const statusOf = async () =>
      (await mt("run", "status", "--run", runId)).json.data as { status: string; stage: string };
    // The real diff grew past quick: MetatorAI asks, as a run question.
    await page.goto(app("inbox"));
    const past = await decisionOnHome(page, ["This grew past quick"], 90_000);
    expect(await past.locator("h1").textContent()).toBe(
      "This grew past quick: untested (no test reaches src/rate.ts)",
    );
    expect(await past.locator(".option .label > span:first-child").allTextContents()).toEqual([
      "Continue as full",
      "Keep as quick",
      "Other",
    ]);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "grew-past-quick-card.png") });
    await past.locator(".option", { hasText: "Keep as quick" }).click();
    await past.getByRole("button", { name: /^Keep as quick ⏎/ }).click();
    await nameIfAsked();
    // The run goes on to its end: one card, the diff not committed.
    const ready = await decisionOnHome(page, ["Quick change ready: look at the diff"], 90_000);
    expect(await ready.locator("h1").textContent()).toBe("Quick change ready: look at the diff");
    expect(await ready.locator(".option .label > span:first-child").allTextContents()).toEqual([
      "Open diff",
      "Fine",
      "Other",
    ]);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "quick-ready-card.png") });
    // Open diff: the run's Changes tab with the change; no answer is sent, the run still waits.
    await ready.locator(".option", { hasText: "Open diff" }).click();
    await ready.getByRole("button", { name: /^Open diff ⏎/ }).click();
    await until("the Changes tab", async () =>
      page.url().includes(`#/run/${runId}/changes`) ? true : undefined,
    );
    await page.getByTestId("file-src/rate.ts").waitFor({ timeout: 20_000 });
    expect(await statusOf()).toMatchObject({ status: "active", stage: "ready" });
    // Fine ends the run; the app says so; nothing was committed.
    await page.goto(app("inbox"));
    const again = await decisionOnHome(page, ["Quick change ready: look at the diff"]);
    await again.locator(".option", { hasText: "Fine" }).click();
    await again.getByRole("button", { name: /^Fine ⏎/ }).click();
    await nameIfAsked();
    await until("the run done", async () => ((await statusOf()).status === "done" ? true : undefined));
    await until("the confirmation", async () =>
      (
        await page
          .locator("main.content > .notice")
          .textContent()
          .catch(() => "")
      )?.includes("Answered: Fine. The run is done.")
        ? true
        : undefined,
    );
    expect((await repo.git("status", "--porcelain")).trim()).toBe("?? src/rate.ts");
    await rm(repo.path("src/rate.ts"));
    await post(`/runs/${runId}/close-panes`, {});
  }, 240_000);

  test("Debug changes (N) from real scratch records: removed, could not be removed and stays as changed, gone, forgotten; each is said", async () => {
    // A task with a terminal, for its Terminals bar (before the tree holds debug edits).
    const task = (
      (await mt("run", "new", "--workflow", "mt-feature", "--task", "The task with debug changes")).json
        .data as { runId: string }
    ).runId;
    expect((await post(`/runs/${task}/pty-open`, {})).ok).toBe(true);
    // Three debug edits, recorded as the chat's agent records them.
    const one = await scratchEdit(
      { "src/price.ts": `${PRICE}console.log("price called");\n` },
      "trace price calls",
    );
    const two = await scratchEdit({ "src/tax.ts": `${TAX}console.log("tax called");\n` });
    const three = await scratchEdit({ "debug.log": "trace\n" }, "a temporary flag");
    expect((await stateOf()).scratch).toBe(3);

    // Home: the entry with its count; the list with files, notes and times.
    await page.goto(app("inbox"));
    const entry = page.getByTestId("debug-changes").first();
    await until("the entry", async () =>
      (await entry.textContent().catch(() => "")) === "Debug changes (3)" ? true : undefined,
    );
    await entry.click();
    const dialog = page.getByRole("dialog", { name: "Debug changes" });
    const result = dialog.getByTestId("debug-changes-result");
    await dialog.getByTestId(`scratch-${one}`).waitFor({ timeout: 10_000 });
    expect(await dialog.getByTestId(`scratch-${one}`).textContent()).toContain(
      "src/price.ts · trace price calls",
    );
    expect(await dialog.getByTestId(`scratch-${two}`).textContent()).toContain("src/tax.ts");
    expect(await dialog.getByTestId(`scratch-${three}`).textContent()).toContain(
      "debug.log · a temporary flag",
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "debug-changes.png") });
    // One removed: its lines are out of the file again.
    await dialog.getByTestId(`scratch-${one}`).getByRole("button", { name: "Remove" }).click();
    await nameIfAsked();
    await until("the result of one", async () =>
      (await result.textContent().catch(() => ""))?.includes("Removed 1 debug change (src/price.ts).")
        ? true
        : undefined,
    );
    expect(await repo.read("src/price.ts")).toBe(PRICE);
    await until("it left the list", async () =>
      (await dialog.getByTestId(`scratch-${one}`).count()) === 0 ? true : undefined,
    );
    await page.keyboard.press("Escape");
    await until("the count after one", async () =>
      (await entry.textContent().catch(() => "")) === "Debug changes (2)" ? true : undefined,
    );

    // The line BEFORE the debug line in src/tax.ts is rewritten by hand: the file still holds the
    // debug line, but its patch no longer applies.
    const rewritten = `${TAX.replace("0.23", "0.08")}console.log("tax called");\n`;
    await repo.write("src/tax.ts", rewritten);
    // A task's Terminals bar has the entry too; "Remove debug changes" removes all it can.
    await page.goto(app(`grid/task/${task}`));
    const inBar = page.getByTestId("terminals-bar").getByTestId("debug-changes");
    await until("the entry in the bar", async () =>
      (await inBar.textContent().catch(() => "")) === "Debug changes (2)" ? true : undefined,
    );
    await inBar.click();
    // The list already says which one can no longer be removed as recorded, and why.
    const changed = dialog.getByTestId(`scratch-changed-${two}`);
    await changed.waitFor({ timeout: 10_000 });
    expect(await changed.textContent()).toBe(
      "Cannot be removed: src/tax.ts changed since it was recorded: its debug lines can no longer be taken out as they were. Take its lines out by hand, or forget it.",
    );
    // "Remove debug changes" takes out what it can; the changed one is not asked for, and stays.
    await dialog.getByTestId("remove-debug-changes").click();
    await nameIfAsked();
    await until("the removable one removed", async () =>
      (await result.textContent().catch(() => "")) === "Removed 1 debug change (debug.log)."
        ? true
        : undefined,
    );
    expect(await repo.exists("debug.log")).toBe(false);
    expect(await repo.read("src/tax.ts")).toBe(rewritten);
    await until("the changed one still listed", async () =>
      (await dialog.locator("[data-testid^='scratch-s']").count()) === 1 &&
      (await dialog.getByTestId(`scratch-${two}`).getAttribute("data-state")) === "changed"
        ? true
        : undefined,
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "debug-changes-removed.png") });
    await dialog.getByRole("button", { name: "Close" }).click();
    // It still counts.
    await until("the count with the changed one", async () =>
      (await inBar.textContent().catch(() => "")) === "Debug changes (1)" ? true : undefined,
    );

    // A removal that fails: the line before a debug line is rewritten while the list is open.
    const four = await scratchEdit(
      { "src/price.ts": `${PRICE}console.log("again");\n` },
      "rewritten under it",
    );
    await page.goto(app("inbox"));
    await until("two again", async () =>
      (await entry.textContent().catch(() => "")) === "Debug changes (2)" ? true : undefined,
    );
    await entry.click();
    await dialog.getByTestId(`scratch-${four}`).waitFor({ timeout: 10_000 });
    const priceRewritten = `${PRICE.replace("=> n", "=> n * 1")}console.log("again");\n`;
    await repo.write("src/price.ts", priceRewritten);
    await dialog.getByTestId(`scratch-${four}`).getByRole("button", { name: "Remove" }).click();
    await nameIfAsked();
    await until("what could not be removed", async () =>
      (await result.textContent().catch(() => ""))?.includes("could not be removed") ? true : undefined,
    );
    expect(await result.textContent()).toBe(
      "Nothing was removed. 1 debug change could not be removed: src/price.ts changed since it was recorded: its debug lines can no longer be taken out as they were. Nothing was forced: it stays in the list; take its lines out by hand, or forget it.",
    );
    // Nothing was forced: the file is as the person left it, and the record stays, as changed.
    expect(await repo.read("src/price.ts")).toBe(priceRewritten);
    await until("it stays as changed", async () =>
      (await dialog.getByTestId(`scratch-${four}`).getAttribute("data-state")) === "changed"
        ? true
        : undefined,
    );
    expect((await stateOf()).scratch).toBe(2);

    // Gone: the person takes that debug line out by hand; the next list says the record is gone.
    await repo.write("src/price.ts", PRICE.replace("=> n", "=> n * 1"));
    await dialog.getByRole("button", { name: "Close" }).click();
    await entry.click();
    const gone = dialog.getByTestId("debug-changes-gone");
    await gone.waitFor({ timeout: 10_000 });
    expect(await gone.textContent()).toBe(`${four} is gone: src/price.ts no longer holds it.`);
    expect(await dialog.getByTestId(`scratch-${four}`).count()).toBe(0);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "debug-changes-gone.png") });

    // Forget: the changed record of src/tax.ts is dismissed; the file is not touched.
    await dialog.getByTestId(`scratch-${two}`).getByRole("button", { name: "Forget" }).click();
    await nameIfAsked();
    await until("forgotten", async () =>
      (await result.textContent().catch(() => "")) ===
      "Forgot 1 debug change (src/tax.ts): its lines stay in your files."
        ? true
        : undefined,
    );
    expect(await repo.read("src/tax.ts")).toBe(rewritten);
    await dialog.getByText("No debug change is left.").waitFor({ timeout: 10_000 });
    await dialog.getByRole("button", { name: "Close" }).click();
    await until("the entry gone", async () => ((await entry.count()) === 0 ? true : undefined));
    expect((await stateOf()).scratch).toBe(0);

    // Gone, found by a removal: the debug line is taken out by hand while the list is open.
    const five = await scratchEdit({ "notes.txt": "a debug note\n" }, "taken out by hand");
    await until("one more", async () =>
      (await entry.textContent().catch(() => "")) === "Debug changes (1)" ? true : undefined,
    );
    await entry.click();
    await dialog.getByTestId(`scratch-${five}`).waitFor({ timeout: 10_000 });
    await rm(repo.path("notes.txt"));
    await dialog.getByTestId(`scratch-${five}`).getByRole("button", { name: "Remove" }).click();
    await nameIfAsked();
    await until("the removal says it is gone", async () =>
      (await result.textContent().catch(() => "")) === `${five} is gone: notes.txt no longer holds it.`
        ? true
        : undefined,
    );
    await dialog.getByRole("button", { name: "Close" }).click();
    await until("the entry gone again", async () => ((await entry.count()) === 0 ? true : undefined));

    await mt("run", "close", "--run", task, "--aborted", "--reason", "the test ends here");
    expect(errors.filter((e) => !/Notification|favicon/.test(e))).toEqual([]);
  }, 240_000);
});
