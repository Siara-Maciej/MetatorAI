/**
 * Stage 1 of the conversation agent in the app (round 13; real daemon, real Chromium, no real AI
 * host: a stand-in `claude` draws Claude Code's approval of a `git commit`). The "+ New run" chat
 * opens the repository's conversation agent with the label "chat"; its commit waits as a consent
 * card whose heading is the command; the quick cards are run questions (asked here with
 * `metator run ask`, as the engine will ask them): "Open diff" opens the run's Changes and leaves
 * the card, "Fine" closes it; "Debug changes (N)" lists and removes the recorded debug changes.
 * On fixtures until the daemon sends them (scratchpad/round13/desktop-needs.md): `/supervisor`
 * `chatAgent`, the state's `scratch` count, `GET /scratch` and `POST /scratch/drop`.
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
const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";
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
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nbin/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("src/currency.ts", "export const CURRENCIES = ['PLN'];\n");
  await repo.write("bin/approval.txt", `${APPROVAL}\n`);
  await repo.write(
    "bin/claude",
    `#!/bin/sh\ncat "${repo.path("bin/approval.txt")}"\nread -r key\nprintf 'picked %s\\n' "$key"\nsleep 60\n`,
  );
  chmodSync(repo.path("bin/claude"), 0o755);
  await repo.commit("init");
  env = {
    METATOR_CONFIG_DIR: configDir,
    METATOR_CLAUDE_BIN: repo.path("bin/claude"),
    METATOR_COPILOT_BIN: "/nonexistent/copilot",
    METATOR_OPENCODE_BIN: "/nonexistent/opencode",
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

describe("the conversation agent's first stage in the app (round 13)", () => {
  test("+ New run opens the repository's conversation agent as the chat; its commit waits as a consent card", async () => {
    await page.goto(app("inbox"));
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    // A repository without the conversation agent (the daemon names none): the agent of before.
    await page.getByRole("button", { name: "+ New run" }).click();
    const first = await until("the chat pane", async () => (await panes())[0]);
    expect([first.label, first.role, first.process.agent]).toEqual(["chat", "apps", "mt-orchestrator"]);
    await fetch(`${base}/panes/${first.id}/close`, { method: "POST", body: "{}" });
    await until("the pane closed", async () => ((await panes()).length === 0 ? true : undefined));
    // FIXTURE: the daemon names the repository's conversation agent (`/supervisor` `chatAgent`).
    await page.route("**/supervisor**", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { data?: Record<string, unknown> };
      if (body.data) body.data.chatAgent = "mt-chat";
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(app("inbox"));
    await page.getByRole("button", { name: "+ New run" }).click();
    const chat = await until("the chat pane", async () => (await panes())[0]);
    expect([chat.label, chat.role, chat.process.agent, chat.process.host]).toEqual([
      "chat",
      "apps",
      "mt-chat",
      "claude",
    ]);
    // The chat's agent asks to commit: the guard lets the host ask, and that is a card on Home.
    await page.goto(app("inbox"));
    const card = page.getByTestId(`pane-ask-${chat.id}`);
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
      const r = (await api(`/panes/${chat.id}`)) as { data: { text: string } };
      return r.data.text.includes("picked 1") ? true : undefined;
    });
    await until("the card to go", async () => ((await card.count()) === 0 ? true : undefined));
  }, 120_000);

  test("the quick cards: Open diff opens the run's change and leaves the card, Fine closes it; grew past quick has its two answers", async () => {
    const created = await metator(
      ["run", "new", "--workflow", "demo", "--task", "Add EUR to the currencies"],
      repo.root,
      env,
    );
    const runId = (created.json.data as { runId: string }).runId;
    await repo.write("src/currency.ts", "export const CURRENCIES = ['PLN', 'EUR'];\n");
    // The engine asks these as run questions; here the same question is asked with the CLI.
    const ask = (question: string, ...options: string[]) =>
      metator(
        ["run", "ask", question, ...options.flatMap((o) => ["--option", o]), "--run", runId],
        repo.root,
        env,
      );
    expect((await ask("Quick change ready: look at the diff", "Open diff", "Fine")).code).toBe(0);
    await page.goto(app("inbox"));
    const card = await decisionOnHome(page, ["Quick change ready: look at the diff"]);
    expect(await card.locator("h1").textContent()).toBe("Quick change ready: look at the diff");
    const labels = await card.locator(".option .label > span:first-child").allTextContents();
    expect(labels.slice(0, 2)).toEqual(["Open diff", "Fine"]);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "quick-ready-card.png") });
    // Open diff: the run's Changes tab; no answer is sent, the question stays open.
    await card.locator(".option", { hasText: "Open diff" }).click();
    await card.getByRole("button", { name: /^Open diff ⏎/ }).click();
    await until("the Changes tab", async () =>
      page.url().includes(`#/run/${runId}/changes`) ? true : undefined,
    );
    await page.getByTestId("file-src/currency.ts").waitFor({ timeout: 20_000 });
    const open = async () =>
      (
        (await api("/inbox")) as { data: { decisions: { runId: string; question: { prompt: string } }[] } }
      ).data.decisions.filter((d) => d.runId === runId);
    expect((await open()).map((d) => d.question.prompt)).toEqual(["Quick change ready: look at the diff"]);
    // Fine closes the card.
    await page.goto(app("inbox"));
    const again = await decisionOnHome(page, ["Quick change ready: look at the diff"]);
    await again.locator(".option", { hasText: "Fine" }).click();
    await again.getByRole("button", { name: /^Fine ⏎/ }).click();
    await nameIfAsked();
    await until("the card closed", async () => ((await open()).length === 0 ? true : undefined));

    // "This grew past quick": which escalators, and the two answers.
    const grew = "This grew past quick: size (7 files, 5 allowed); a new dependency (zod)";
    // (An answered run is driven on by the daemon, and no host can here: the second card is another run's.)
    const second = (
      (
        await metator(
          ["run", "new", "--workflow", "demo", "--task", "Add USD to the currencies"],
          repo.root,
          env,
        )
      ).json.data as { runId: string }
    ).runId;
    const asked = await metator(
      ["run", "ask", grew, "--option", "Continue as full", "--option", "Keep as quick", "--run", second],
      repo.root,
      env,
    );
    expect([asked.code, asked.json.error ?? null]).toEqual([0, null]);
    await page.goto(app("inbox"));
    const past = await decisionOnHome(page, ["This grew past quick"]);
    expect(await past.locator("h1").textContent()).toBe(grew);
    expect((await past.locator(".option .label > span:first-child").allTextContents()).slice(0, 2)).toEqual([
      "Continue as full",
      "Keep as quick",
    ]);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "grew-past-quick-card.png") });
    await past.locator(".option", { hasText: "Keep as quick" }).click();
    await past.getByRole("button", { name: /^Keep as quick ⏎/ }).click();
    await nameIfAsked();
    await until("the answer", async () => {
      const entries = (
        (await api(`/runs/${second}/activity`)) as { data: { entries: { type: string; text: string }[] } }
      ).data.entries;
      return entries.some((e) => e.type === "answer" && e.text.includes("Keep as quick")) ? true : undefined;
    });
    for (const id of [runId, second])
      await metator(
        ["run", "close", "--run", id, "--aborted", "--reason", "the test ends here"],
        repo.root,
        env,
      );
  }, 120_000);

  test("Debug changes (N): on Home and in a task's Terminals bar; one removed, then all, with what could not be", async () => {
    // FIXTURES (until the daemon has them): the state's count, the list, the drop.
    let items = [
      { id: "s1", files: ["src/currency.ts"], note: "why the total is off", at: "2026-11-21T10:00:00.000Z" },
      { id: "s2", files: ["src/price.ts", "src/tax.ts"], at: "2026-11-21T10:05:00.000Z" },
      { id: "s3", file: "src/invoice.ts", note: "a temporary flag", at: "2026-11-21T10:07:00.000Z" },
    ];
    const drops: string[] = [];
    let sockets: { send(m: string): void }[] = [];
    let lastState: { ok: boolean; data?: Record<string, unknown> } | undefined;
    const counted = (env: { ok: boolean; data?: Record<string, unknown> }) => {
      if (env.data) env.data.scratch = items.length;
      return env;
    };
    await page.route("**/state", async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: counted(await res.json()) });
    });
    await page.routeWebSocket("**/ws/state**", (ws) => {
      const server = ws.connectToServer();
      sockets.push(ws);
      server.onMessage((m) => {
        lastState = JSON.parse(String(m));
        ws.send(JSON.stringify(counted(lastState as never)));
      });
      ws.onMessage((m) => server.send(m));
    });
    // The daemon's state says the new count after a drop.
    const push = () => {
      if (lastState) for (const ws of sockets) ws.send(JSON.stringify(counted(lastState)));
    };
    await page.route("**/scratch", async (route) => route.fulfill({ json: { ok: true, data: { items } } }));
    await page.route("**/scratch/drop", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as { ids?: string[]; by?: string };
      drops.push(JSON.stringify(body));
      const asked = items.filter((i) => !body.ids || body.ids.includes(i.id));
      // s3's patch no longer applies: reported, never forced.
      const failed = asked.filter((i) => i.id === "s3");
      const dropped = asked.filter((i) => i.id !== "s3");
      items = items.filter((i) => !dropped.includes(i));
      push();
      await route.fulfill({
        json: {
          ok: true,
          data: {
            dropped: dropped.map((i) => ({ id: i.id, files: i.files ?? [i.file] })),
            failed: failed.map((i) => ({ id: i.id, files: [i.file], why: "the patch no longer applies" })),
          },
        },
      });
    });

    // Home: the entry with its count; the list with files, notes and times. (A reload: the state's
    // socket is opened again, through the fixture.)
    await page.goto(app("inbox"));
    await page.reload();
    const entry = page.getByTestId("debug-changes");
    await entry.waitFor({ timeout: 20_000 });
    expect(await entry.textContent()).toBe("Debug changes (3)");
    await entry.click();
    const dialog = page.getByRole("dialog", { name: "Debug changes" });
    await dialog.getByTestId("scratch-s1").waitFor({ timeout: 10_000 });
    expect(await dialog.getByTestId("scratch-s1").textContent()).toContain(
      "src/currency.ts · why the total is off",
    );
    expect(await dialog.getByTestId("scratch-s2").textContent()).toContain("src/price.ts, src/tax.ts");
    expect(await dialog.getByTestId("scratch-s3").textContent()).toContain(
      "src/invoice.ts · a temporary flag",
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "debug-changes.png") });
    // One removed.
    await dialog.getByTestId("scratch-s1").getByRole("button", { name: "Remove" }).click();
    await nameIfAsked();
    await until("the result of one", async () =>
      (
        await dialog
          .getByTestId("debug-changes-result")
          .textContent()
          .catch(() => "")
      )?.includes("Removed 1 debug change (src/currency.ts).")
        ? true
        : undefined,
    );
    expect(JSON.parse(drops[0] ?? "{}")).toEqual({ ids: ["s1"], by: "ana" });
    expect(await dialog.getByTestId("scratch-s1").count()).toBe(0);
    await page.keyboard.press("Escape");
    await until("the count after one", async () =>
      (await entry.textContent()) === "Debug changes (2)" ? true : undefined,
    );

    // A task's Terminals bar has the entry too; "Remove debug changes" removes all it can.
    const runId = (
      (
        await metator(
          ["run", "new", "--workflow", "demo", "--task", "The task with debug changes"],
          repo.root,
          env,
        )
      ).json.data as { runId: string }
    ).runId;
    const opened = await fetch(`${base}/runs/${runId}/pty-open`, {
      method: "POST",
      body: JSON.stringify({ host: "claude" }),
    });
    expect(((await opened.json()) as { ok: boolean }).ok).toBe(true);
    await page.goto(app(`grid/task/${runId}`));
    const inBar = page.getByTestId("terminals-bar").getByTestId("debug-changes");
    await inBar.waitFor({ timeout: 20_000 });
    expect(await inBar.textContent()).toBe("Debug changes (2)");
    await inBar.click();
    await dialog.getByTestId("remove-debug-changes").click();
    await nameIfAsked();
    const said = await until("what could not be removed", async () => {
      const t = await dialog
        .getByTestId("debug-changes-result")
        .textContent()
        .catch(() => "");
      return t?.includes("could not be removed") ? t : undefined;
    });
    expect(said).toBe(
      "Removed 1 debug change (src/price.ts, src/tax.ts). 1 debug change could not be removed: src/invoice.ts (the patch no longer applies). Nothing was forced: undo it by hand.",
    );
    expect(JSON.parse(drops[1] ?? "{}")).toEqual({ by: "ana" });
    // What could not be removed is still listed, and still counted.
    expect(await dialog.getByTestId("scratch-s3").count()).toBe(1);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "debug-changes-removed.png") });
    await dialog.getByRole("button", { name: "Close" }).click();
    await until("the count after all", async () =>
      (await inBar.textContent()) === "Debug changes (1)" ? true : undefined,
    );
    // With nothing counted the entry is gone, and nothing asks for the list.
    items = [];
    push();
    await until("the entry gone", async () => ((await inBar.count()) === 0 ? true : undefined));
    sockets = [];
    await metator(
      ["run", "close", "--run", runId, "--aborted", "--reason", "the test ends here"],
      repo.root,
      env,
    );
    expect(errors.filter((e) => !/Notification|favicon/.test(e))).toEqual([]);
  }, 120_000);
});
