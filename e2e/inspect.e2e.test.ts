/**
 * `metator inspect` and `setup --commit` end to end (ADR-0105): real `metator` processes on real
 * git repositories, as the desktop app's "Add repository" runs them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const dirs: string[] = [];
const repos: ScratchRepo[] = [];
afterAll(async () => {
  for (const r of repos) await r.dispose();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), "metator-inspect-")));
  dirs.push(d);
  return d;
}

async function repo(): Promise<ScratchRepo> {
  const r = await ScratchRepo.create();
  repos.push(r);
  await r.git("config", "user.name", "E2E");
  await r.git("config", "user.email", "e2e@example.com");
  await r.git("config", "commit.gpgsign", "false");
  return r;
}

/** A PATH with git and bun only, plus stand-ins for the named host programs: what this machine has installed. */
async function machine(...hosts: string[]): Promise<string> {
  const dir = await temp();
  for (const tool of ["bun", "git"]) await symlink(Bun.which(tool) as string, join(dir, tool));
  for (const h of hosts) {
    await writeFile(join(dir, h), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, h), 0o755);
  }
  return dir;
}

type Inspection = {
  path: string;
  kind: string;
  next: string;
  git: { installed: boolean };
  repository: { root: string; name: string; worktree: boolean; setUp: string; uncommitted: string[] } | null;
  folder: { file: string | null; repos: { name: string; setUp: string }[] } | null;
  hosts: { id: string; installed: boolean; loggedIn: boolean | null }[];
  defaultHost: string | null;
  writes: Record<string, string[]>;
};

describe("metator inspect (real git, real files)", () => {
  test("a repository from setup to commit: what setup writes, setup, set up, and a commit of exactly those files", async () => {
    const r = await repo();
    await r.write("README.md", "# shop\n");
    await r.commit("init");
    await r.write("notes.txt", "mine, not setup's\n");
    const home = await temp();
    const env = { PATH: await machine("claude"), HOME: home, METATOR_NO_REAL_HOSTS: "1" };
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude", ".credentials.json"), "{}");

    const before = await metator(["inspect", r.root, "--json"], await temp(), env);
    expect(before.code).toBe(0);
    const i = before.json.data as Inspection;
    expect([i.kind, i.next, i.repository?.setUp, i.repository?.uncommitted]).toEqual([
      "repo",
      "setup",
      "no",
      ["notes.txt"],
    ]);
    expect(i.hosts).toEqual([
      expect.objectContaining({ id: "copilot", installed: false, loggedIn: null }),
      expect.objectContaining({ id: "claude", installed: true, loggedIn: true }),
    ]);
    expect(i.defaultHost).toBe("claude");
    expect(i.writes.claude).toContain("metator.config.yml");
    expect(i.writes.claude).toContain(".claude/settings.json");
    expect(i.writes.copilot?.some((f) => f.startsWith(".github/agents/"))).toBe(true);
    // Read only: inspecting wrote nothing in the repository.
    expect((await r.git("status", "--porcelain")).trim()).toBe("?? notes.txt");
    // Deterministic: the same folder on the same machine gives the same answer.
    expect((await metator(["inspect", r.root], await temp(), env)).json).toEqual(before.json);

    const setup = await metator(["-C", r.root, "setup", "--host", "claude", "--yes"], r.root, env);
    expect(setup.code).toBe(0);
    const written = (setup.json.data as { written: string[] }).written;
    expect(written).toEqual(i.writes.claude as string[]);

    const after = (await metator(["inspect"], r.root, env)).json.data as Inspection;
    expect([after.next, after.repository?.setUp, after.writes]).toEqual(["add", "yes", {}]);

    const commit = await metator(["setup", "--commit", "--files", ...written], r.root, env);
    expect(commit.code).toBe(0);
    const sha = (commit.json.data as { commit: string }).commit;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await r.git("log", "-1", "--format=%H %s")).trim()).toBe(`${sha} Set up MetatorAI`);
    const committed = (await r.git("show", "--name-only", "--format=", "HEAD")).trim().split("\n").sort();
    expect(committed).toEqual([...written].sort());
    // The person's own file is not part of it.
    expect((await r.git("status", "--porcelain")).trim()).toBe("?? notes.txt");

    const outside = await metator(["setup", "--commit", "--files", "../elsewhere.txt"], r.root, env);
    expect([outside.code, (outside.json.error as { code: string }).code]).toEqual([64, "USAGE"]);
  }, 120_000);

  test("a linked worktree counts as its repository; a sub-folder too", async () => {
    const r = await repo();
    await r.write("src/a.ts", "export const a = 1;\n");
    await r.commit("init");
    const wt = join(await temp(), "shop-fix");
    await r.git("worktree", "add", "-q", "-b", "fix", wt);
    const env = { PATH: await machine(), HOME: await temp() };
    const fromWorktree = (await metator(["inspect", wt], await temp(), env)).json.data as Inspection;
    const root = await realpath(r.root);
    expect([fromWorktree.repository?.root, fromWorktree.repository?.worktree]).toEqual([root, true]);
    const fromSub = (await metator(["inspect", join(r.root, "src")], await temp(), env)).json
      .data as Inspection;
    expect([fromSub.repository?.root, fromSub.repository?.worktree]).toEqual([root, false]);
    expect(fromSub.defaultHost).toBeNull();
  }, 60_000);

  test("a folder of repositories, a plain folder, and nothing there", async () => {
    const env = { PATH: await machine("copilot"), HOME: await temp() };
    const work = await temp();
    for (const name of ["api", "web"]) {
      await mkdir(join(work, name));
      Bun.spawnSync(["git", "init", "-q"], { cwd: join(work, name) });
    }
    const folder = (await metator(["inspect", work], await temp(), env)).json.data as Inspection;
    expect([folder.kind, folder.next, folder.folder?.file]).toEqual(["folder", "setup-repos", null]);
    expect(folder.folder?.repos.map((x) => [x.name, x.setUp])).toEqual([
      ["api", "no"],
      ["web", "no"],
    ]);
    expect(folder.defaultHost).toBe("copilot");

    const plain = (await metator(["inspect", await temp()], await temp(), env)).json.data as Inspection;
    expect([plain.kind, plain.next]).toEqual(["not-git", "git-init"]);
    const gone = (await metator(["inspect", join(work, "nothing-here")], await temp(), env)).json
      .data as Inspection;
    expect([gone.kind, gone.next]).toEqual(["missing", "choose-another"]);
  }, 60_000);
});
