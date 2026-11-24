import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dir, "..");

/** The shell script of the nightly step that commits the regenerated knowledge and opens its PR. */
async function refreshScript(): Promise<string> {
  const wf = parse(await Bun.file(join(ROOT, ".github/workflows/mt-nightly.yml")).text()) as {
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
  };
  const step = Object.values(wf.jobs)
    .flatMap((j) => j.steps)
    .find((s) => s.name === "Pull request with the regenerated knowledge");
  if (!step?.run) throw new Error("the nightly step is gone");
  return step.run;
}

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...args], {
    cwd,
  });

/** A checkout with a bare origin, and a `gh` on PATH that records what it was asked. */
async function checkout() {
  const base = await mkdtemp(join(tmpdir(), "metator-nightly-"));
  dirs.push(base);
  const origin = join(base, "origin.git");
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  Bun.spawnSync(["git", "init", "-q", "--bare", origin]);
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "card.md"), "old\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "remote", "add", "origin", origin);
  await mkdir(bin);
  const log = join(base, "gh.log");
  // `gh pr view` finds no PR; `gh pr create` succeeds. Every call is recorded.
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\n[ "$2" = view ] && exit 1\nexit 0\n`,
  );
  await chmod(join(bin, "gh"), 0o755);
  const run = async () => {
    const p = Bun.spawnSync(["bash", "-e", "-c", await refreshScript()], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "x", GITHUB_REF_NAME: "main" },
    });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };
  const ghCalls = async () => ((await Bun.file(log).exists()) ? await Bun.file(log).text() : "");
  return { repo, origin, run, ghCalls };
}

describe("mt-nightly: the pull request with the regenerated knowledge", () => {
  test("only the drift report is new: nothing to commit, the step ends green without a PR", async () => {
    const c = await checkout();
    await writeFile(join(c.repo, "drift.md"), "- a claim no longer holds\n");
    const r = await c.run();
    expect([r.code, r.out.includes("nothing regenerated")]).toEqual([0, true]);
    expect(await c.ghCalls()).toBe("");
  });

  test("a regenerated file: committed on the refresh branch without the drift report, pushed, PR opened", async () => {
    const c = await checkout();
    await writeFile(join(c.repo, "card.md"), "new\n");
    await writeFile(join(c.repo, "drift.md"), "- a claim no longer holds\n");
    const r = await c.run();
    expect(r.code).toBe(0);
    const files = git(c.origin, "show", "--name-only", "--format=", "metator/knowledge-refresh")
      .stdout.toString()
      .trim();
    expect(files).toBe("card.md");
    expect(await c.ghCalls()).toContain("pr create");
  });
});
