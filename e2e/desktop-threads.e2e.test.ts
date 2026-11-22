/**
 * Threads in the app (round 16; real daemon, real Chromium, the scenario host only, never a real AI
 * host). "+ New chat" makes a thread with its chat terminal and opens it; the sidebar is one
 * hierarchy, thread → its tasks, with the runs no thread lists under "Without a chat"; a run the
 * chat starts is its thread's task, and Home names the thread before the task; closing a thread
 * ends its chat (never its runs) and puts it under "Closed (N)", folded; Reopen brings its chat back.
 * No browser fixture: what the app shows comes from the daemon's routes.
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
const SHOTS = process.env.METATOR_SHOTS;
const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: build
    owner: mt-implementer
  - id: approval
    hitl: true
`;
const CONFIG = `kind: MetatorConfig
schemaVersion: 13
supervisor:
  hostOrder: [scenario]
`;
// The chat greets (no question: it would make the chat need the person); when the test left a task in task.txt it starts that run from its pane, as the
// conversation agent does once the person said what to do. Then it waits.
const CHAT = `    - - say: "I am the chat."
      - run: 'if [ -f task.txt ]; then t="$(cat task.txt)"; rm task.txt; metator run new --workflow demo --task "$t" >/dev/null; fi'
      - run: 'sleep 300'
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-chat:
${CHAT}  mt-orchestrator:
${CHAT}`;
const LINKED = "Add the discount to the invoice";
const LOOSE = "Round the totals";

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
const post = async (path: string, body: unknown) =>
  (await (await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) })).json()) as {
    ok: boolean;
    data: never;
  };
const mt = (...args: string[]) => metator(args, repo.root, env);

type Thread = { id: string; title: string; state: string; runs: string[]; panes: { paneId: string }[] };
type Threads = { threads: Thread[]; closed: Thread[]; withoutChat: { runId: string }[] };
const threads = async () => ((await api("/threads")) as { data: Threads }).data;
type Pane = { id: string; label: string; threadId?: string; ended?: unknown; live?: { alive: boolean } };
const panes = async () => ((await api("/layout")) as { data: { panes: Pane[] } }).data.panes;
const runStatus = async (runId: string) =>
  ((await api("/state")) as { data: { runs: { runId: string; status: string }[] } }).data.runs.find(
    (r) => r.runId === runId,
  )?.status;
const shot = async (name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name) });
};

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-threads-"));
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
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-threads-config-"));
  bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  chmodSync(join(bin, "metator"), 0o755);
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nscenario.yml\ntask.txt\n");
  await repo.write("metator.config.yml", CONFIG);
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("src/invoice.ts", "export const total = (n: number) => n;\n");
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = {
    METATOR_CONFIG_DIR: configDir,
    METATOR_USER: "ana",
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    METATOR_NO_REAL_HOSTS: "1",
    METATOR_CLAUDE_BIN: "/nonexistent/claude",
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
  page = await (await browser()).newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
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

/** "+ New chat" in the sidebar: the thread it made, once the app shows its chat. */
async function newChat(): Promise<Thread> {
  const before = (await threads()).threads.map((t) => t.id);
  await page.getByRole("button", { name: "+ New chat" }).click();
  await nameIfAsked();
  const made = await until("the new thread", async () =>
    (await threads()).threads.find((t) => !before.includes(t.id)),
  );
  await until("the app on the new chat", async () =>
    page.url().endsWith(`#/thread/${made.id}`) ? true : undefined,
  );
  return made;
}

/** The text of a thread's chat terminal on its page, once it holds `words`. */
async function chatSays(thread: Thread, words: string) {
  const screen = page.getByTestId(`thread-${thread.id}`);
  await until(`the chat of ${thread.id} to say "${words}"`, async () =>
    (
      await screen
        .locator(".pane-frame")
        .textContent({ timeout: 1000 })
        .catch(() => "")
    )?.includes(words)
      ? true
      : undefined,
  );
}

const sidebar = () => page.getByRole("complementary", { name: "runs" });
const row = (id: string) => sidebar().getByTestId(`side-thread-${id}`);

describe("threads in the app (round 16)", () => {
  let first: Thread;
  let second: Thread;
  let linkedRun = "";

  test('"+ New chat" makes a thread with its chat terminal and opens it; its row says chat', async () => {
    await page.goto(app("inbox"));
    await page.getByTestId("connection").filter({ hasText: "connected" }).waitFor({ timeout: 20_000 });
    // Nothing yet: no chat, no task, and "+ New run" is gone for "+ New chat"; the form stays.
    await sidebar().getByText("No chat yet.").waitFor({ timeout: 20_000 });
    expect(await page.getByRole("button", { name: "+ New run" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "New run from the form" }).count()).toBe(1);
    first = await newChat();
    expect([first.title, first.state]).toEqual(["New chat", "open"]);
    // Its chat terminal is a pane of the layout that names the thread, and the app shows it.
    const chat = await until("the chat pane", async () =>
      (await panes()).find((p) => p.threadId === first.id),
    );
    expect(chat.label).toBe("chat");
    await chatSays(first, "I am the chat");
    // The sidebar: one row, the thread's title and one word; no task under it yet.
    await row(first.id).waitFor({ timeout: 20_000 });
    const head = row(first.id).locator(".thread-head");
    expect(await head.locator(".title").textContent()).toBe("New chat");
    expect(await head.locator(".word").textContent()).toBe("chat");
    expect(await head.getAttribute("aria-current")).toBe("true");
    expect(await sidebar().getByTestId("without-chat").count()).toBe(0);
    await shot("new-chat.png");
  }, 90_000);

  test("one hierarchy: a run the chat starts is its thread's task; a run from a terminal is Without a chat; Home names the thread", async () => {
    // The chat starts the run from its pane (as mt-chat does with `metator run new`): the daemon links it.
    await repo.write("task.txt", LINKED);
    second = await newChat();
    const linked = await until("the run linked to the thread", async () => {
      const t = (await threads()).threads.find((x) => x.id === second.id);
      return t && t.runs.length > 0 ? t : undefined;
    });
    linkedRun = linked.runs[0] as string;
    // The agent names the thread (`metator thread summary --title`).
    const named = await post(`/threads/${second.id}/summary`, {
      text: "The invoice gets a discount over 1000.",
      title: "Invoice discount",
    });
    expect(named.ok).toBe(true);
    // A run started in a terminal, from no chat.
    const loose = await mt("run", "new", "--workflow", "demo", "--task", LOOSE);
    expect([loose.code, loose.json.error ?? null]).toEqual([0, null]);
    const looseRun = (loose.json.data as { runId: string }).runId;
    expect((await threads()).withoutChat.map((r) => r.runId)).toContain(looseRun);

    await page.goto(app("inbox"));
    const head = row(second.id).locator(".thread-head");
    await until("the thread's new title", async () =>
      (await head
        .locator(".title")
        .textContent({ timeout: 1000 })
        .catch(() => "")) === "Invoice discount"
        ? true
        : undefined,
    );
    // The thread row: its title, the word of its one task (nothing drives it: blocked), how many tasks.
    expect(await head.locator(".word").textContent()).toBe("blocked");
    expect(await head.locator(".sub").textContent()).toBe("1 task");
    // Under it, its task's row; the run from the terminal is in "Without a chat", not under a thread.
    const task = row(second.id).locator(".thread-tasks").getByTestId(`side-task-run:/${linkedRun}`);
    await task.waitFor({ timeout: 20_000 });
    expect(await task.locator(".title").first().textContent()).toBe(LINKED);
    const without = sidebar().getByTestId("without-chat");
    await without.waitFor({ timeout: 20_000 });
    expect(await without.locator(".section").first().textContent()).toBe("Without a chat · 1");
    expect(
      await without.getByTestId(`side-task-run:/${looseRun}`).locator(".title").first().textContent(),
    ).toBe(LOOSE);
    expect(await row(first.id).locator(".thread-tasks").count()).toBe(0);
    // The newest thread first: it changed last.
    const order = await sidebar()
      .locator('section[aria-label="chats"] > .thread')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(order).toEqual([`side-thread-${second.id}`, `side-thread-${first.id}`]);
    // Home: the task names its thread before its own name, dim; a task of no thread has no prefix.
    const home = page.getByTestId("home-tasks");
    await home.waitFor({ timeout: 20_000 });
    const lines = await home.locator("li").allTextContents();
    expect(lines.find((l) => l.includes(LINKED))).toContain(`Invoice discount · ${LINKED}`);
    expect(lines.find((l) => l.includes(LOOSE))).not.toContain(" · Round");
    // Nothing drives these tasks: Home does not say "nothing" over them, and says what each needs.
    expect(await page.getByTestId("inbox-zero").locator("h2").textContent()).toBe(
      "No decision waits for you",
    );
    expect(await page.getByTestId("inbox-zero").textContent()).not.toContain("Nothing needs you");
    expect(lines.find((l) => l.includes(LINKED))).toContain("nothing drives it: Open a session");
    await shot("sidebar-hierarchy.png");
    // A click on the thread opens its chat terminal as the main view, with its task as a tile.
    await head.click();
    await chatSays(second, "I am the chat");
    expect(await page.getByTestId("thread-tasks").textContent()).toContain(LINKED);
    await shot("thread-chat.png");
  }, 120_000);

  test('closing a thread ends its chat, never its runs, and folds it under "Closed (N)"; Reopen brings the chat back', async () => {
    const statusBefore = await runStatus(linkedRun);
    expect(statusBefore).toBe("active");
    // Close from the thread's ⋯ in the sidebar.
    await row(second.id).getByRole("button", { name: "more for Invoice discount" }).click();
    await page.getByRole("menuitem", { name: "Close chat" }).click();
    await nameIfAsked();
    await until("the thread closed", async () =>
      (await threads()).closed.some((t) => t.id === second.id) ? true : undefined,
    );
    const chatPane = second.panes.at(-1)?.paneId ?? "";
    await until("its chat ended", async () =>
      (await panes()).find((p) => p.id === chatPane)?.ended !== undefined ? true : undefined,
    );
    // Its run goes on as it was, and is still the closed thread's (not "Without a chat").
    expect(await runStatus(linkedRun)).toBe(statusBefore);
    expect((await threads()).withoutChat.map((r) => r.runId)).not.toContain(linkedRun);
    // The sidebar: "Closed (1)", folded; its page says it is closed and offers Reopen.
    const closed = sidebar().getByTestId("show-closed");
    await closed.waitFor({ timeout: 20_000 });
    expect(await closed.textContent()).toContain("Closed (1)");
    expect(await closed.getAttribute("aria-expanded")).toBe("false");
    expect(await row(second.id).count()).toBe(0);
    await page.getByTestId("thread-closed").waitFor({ timeout: 20_000 });
    // Unfolded, the closed thread's row reads closed.
    await closed.click();
    await row(second.id).waitFor({ timeout: 10_000 });
    expect(await row(second.id).locator(".thread-head .word").textContent()).toBe("closed");
    await shot("sidebar-closed.png");
    // Reopen from its bar: open again, its chat runs again.
    await page.getByRole("button", { name: "Reopen chat" }).click();
    await nameIfAsked();
    await until("the thread open again", async () =>
      (await threads()).threads.some((t) => t.id === second.id) ? true : undefined,
    );
    await chatSays(second, "I am the chat");
    expect(await sidebar().getByTestId("show-closed").count()).toBe(0);
    expect(await row(second.id).locator(".thread-head .word").textContent()).toBe("blocked");
    expect(errors).toEqual([]);
  }, 120_000);
});
