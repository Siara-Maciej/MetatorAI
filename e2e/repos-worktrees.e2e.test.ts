/**
 * A folder with three repositories, one of them with two worktrees of its own (`git worktree add
 * ../shop-fix`): the folder counts three repositories, lists the worktrees under theirs, and work
 * made in a worktree shows under its repository, in the CLI and from the daemon that serves it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { inTerminal } from "./helpers/terminal.ts";

const WORKFLOW = "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: approval\n    hitl: true\n";
let folder: string;
const at = (name: string) => join(folder, name);

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

async function gitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  await Bun.write(join(dir, ".gitignore"), ".metator/\n");
  await Bun.write(join(dir, ".github/metator/workflows/demo.yml"), WORKFLOW);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

type Repo = { name: string; path: string; worktrees: { name: string; path: string; branch?: string }[] };
const reposOf = (r: { json: Record<string, unknown> }) => (r.json.data as { repos: Repo[] }).repos;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "metator-worktrees-e2e-"));
  for (const name of ["shop", "billing", "web"]) await gitRepo(at(name));
  git(at("shop"), "worktree", "add", "-q", "-b", "fix-tax", "../shop-fix");
  git(at("shop"), "worktree", "add", "-q", "-b", "wip", "../shop-wip");
}, 60_000);
afterAll(async () => {
  stopProcessesUnder(folder);
  await rm(folder, { recursive: true, force: true });
});

describe("worktrees in a folder of repositories (real CLI, real git)", () => {
  test("repos list counts repositories; a worktree is listed under its repository with its branch", async () => {
    const list = await metator(["repos", "list"], folder);
    expect(list.code).toBe(0);
    const repos = reposOf(list);
    expect(repos.map((r) => r.name)).toEqual(["billing", "shop", "web"]);
    const shop = repos.find((r) => r.name === "shop") as Repo;
    expect(shop.worktrees.map((w) => [w.name, w.path, w.branch])).toEqual([
      ["shop-fix", "shop-fix", "fix-tax"],
      ["shop-wip", "shop-wip", "wip"],
    ]);
    // A one-repository command in the folder counts the same three.
    const here = await metator(["run", "init", "--workflow", "demo", "--task", "x"], folder);
    expect((here.json.error as { message: string }).message).toBe(
      `\`metator run init\` works on one repository, and ${folder} is a folder of 3`,
    );
  }, 60_000);

  test("a v1 metator.repos.yml that lists a worktree as a repository counts it once and says so", async () => {
    const file = join(folder, "metator.repos.yml");
    await Bun.write(
      file,
      "kind: RepoSet\nschemaVersion: 1\nrepos:\n  - path: shop-fix\n  - path: shop\n  - path: billing\n",
    );
    const list = await metator(["repos", "list"], folder);
    expect(list.code).toBe(0);
    expect(reposOf(list).map((r) => [r.name, r.worktrees.map((w) => w.name)])).toEqual([
      ["shop", ["shop-fix"]],
      ["billing", []],
    ]);
    expect(list.json.warnings).toEqual(["shop-fix is a worktree of shop; counted once"]);
    await rm(file);
  }, 60_000);

  test("repos init writes each repository with its worktrees (RepoSet v2)", async () => {
    const init = await metator(["repos", "init"], folder);
    expect(init.code).toBe(0);
    const text = await Bun.file(join(folder, "metator.repos.yml")).text();
    expect(text).toContain("schemaVersion: 2");
    expect(text).toContain("  - path: shop\n    worktrees:\n      - shop-fix\n      - shop-wip\n");
    const list = await metator(["repos", "list"], folder);
    expect(reposOf(list).map((r) => [r.name, r.worktrees.length])).toEqual([
      ["billing", 0],
      ["shop", 2],
      ["web", 0],
    ]);
    expect(list.json.warnings ?? []).toEqual([]);
  }, 60_000);

  test("a run made in a worktree is shown under its repository by status and repos status", async () => {
    const made = await metator(
      ["run", "init", "--workflow", "demo", "--task", "Fix the tax"],
      at("shop-fix"),
    );
    expect(made.code).toBe(0);
    const status = await metator(["status"], folder);
    const repos = (
      status.json.data as {
        repos: { name: string; runs: unknown[]; worktrees?: { label: string; runs: { task: string }[] }[] }[];
      }
    ).repos;
    expect(repos).toHaveLength(3);
    const shop = repos.find((r) => r.name === "shop");
    expect(shop?.runs).toEqual([]);
    expect(shop?.worktrees?.map((w) => [w.label, w.runs.map((r) => r.task)])).toEqual([
      ["shop (fix-tax)", ["Fix the tax"]],
      ["shop (wip)", []],
    ]);
    const rs = await metator(["repos", "status"], folder);
    const rows = (
      rs.json.data as { repos: { name: string; runs: number; sessions: { checkout?: string }[] }[] }
    ).repos;
    expect(rows.map((r) => [r.name, r.runs])).toEqual([
      ["billing", 0],
      ["shop", 1],
      ["web", 0],
    ]);
    expect(rows[1]?.sessions.map((s) => s.checkout)).toEqual(["shop (fix-tax)"]);
    const text = await inTerminal(["status"], folder, [], 60_000);
    expect(text.code).toBe(0);
    for (const words of ["3 repositories", "shop · 2 worktrees", "shop (fix-tax)", "Fix the tax"])
      expect(text.screen).toContain(words);
  }, 120_000);

  test("the daemon serves every checkout: a worktree is a place of its repository, with its work", async () => {
    const daemon = Bun.spawn(
      ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"],
      {
        cwd: folder,
        env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    try {
      const reader = daemon.stderr.getReader();
      let said = "";
      let url = "";
      const deadline = Date.now() + 30_000;
      while (!url && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        said += new TextDecoder().decode(value);
        const line = said.split("\n").find((l) => l.includes('"serving"'));
        if (line) url = (JSON.parse(line) as { serving: { url: string } }).serving.url;
      }
      reader.releaseLock();
      expect(url).not.toBe("");
      const state = (await (await fetch(`${url}/state`)).json()) as {
        data: {
          repos: { name: string; worktreeOf?: string; branch?: string; runs: { task: string }[] }[];
        };
      };
      expect(state.data.repos.map((r) => [r.name, r.worktreeOf, r.branch])).toEqual([
        ["billing", undefined, undefined],
        ["shop", undefined, undefined],
        ["shop-fix", "shop", "fix-tax"],
        ["shop-wip", "shop", "wip"],
        ["web", undefined, undefined],
      ]);
      const fix = state.data.repos.find((r) => r.name === "shop-fix");
      expect(fix?.runs.map((r) => r.task)).toEqual(["Fix the tax"]);
      // A command run inside the worktree finds the daemon: its address is in the checkout's .metator.
      expect(existsSync(join(at("shop-fix"), ".metator/daemon.json"))).toBe(true);
      // A request names the worktree as the place it is: the run is found there, not in its repository.
      const runId = (fix?.runs[0] as unknown as { runId: string } | undefined)?.runId;
      const there = await fetch(`${url}/runs/${runId}/artifacts?repo=shop-fix`);
      const inShop = await fetch(`${url}/runs/${runId}/artifacts?repo=shop`);
      expect([there.status, inShop.status]).toEqual([200, 404]);
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
  }, 90_000);
});
