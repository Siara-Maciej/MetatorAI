import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "@metator/plugin-bun";
import { ScriptedProcessRunner } from "@metator/testing";
import { GitCliRepository } from "../src/git-cli-repository.ts";

const runner = new BunProcessRunner();
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const IDENTITY = ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
function git(cwd: string, ...argv: string[]): string {
  const r = Bun.spawnSync(["git", ...IDENTITY, ...argv], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "metator-gitcli-")));
  dirs.push(dir);
  return dir;
}

describe("GitCliRepository (ADR-0105)", () => {
  test("version: git's, or none when git is not there", async () => {
    expect(await new GitCliRepository(runner).version()).toMatch(/^\d+\.\d+/);
    expect(await new GitCliRepository(new ScriptedProcessRunner()).version()).toBeUndefined();
  });

  test("checkout: the top level from a sub-folder; a linked worktree's main checkout; none outside", async () => {
    const dir = await temp();
    git(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.ts"), "a\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    await mkdir(join(dir, "src"));
    const g = new GitCliRepository(runner);
    expect(await g.checkout(join(dir, "src"))).toEqual({ top: dir, main: dir });
    const wt = join(await temp(), "shop-fix");
    git(dir, "worktree", "add", "-q", "-b", "fix", wt);
    expect(await g.checkout(wt)).toEqual({ top: wt, main: dir });
    expect(await g.checkout(await temp())).toBeUndefined();
  });

  test("checkout on git before 2.31 (no --path-format, e.g. Debian 11's 2.30): the same answers", async () => {
    // git 2.30 does not know --path-format: it refuses it, as the real one did in CI's debian:bullseye.
    const old: typeof runner = Object.assign(Object.create(runner), {
      run: (spec: Parameters<typeof runner.run>[0]) =>
        spec.argv.some((a) => a.startsWith("--path-format"))
          ? Promise.resolve({
              exitCode: 129,
              stdout: "",
              stderr: "error: unknown option `path-format=absolute'",
            })
          : runner.run(spec),
    });
    const dir = await temp();
    git(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.ts"), "a\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    await mkdir(join(dir, "src"));
    const g = new GitCliRepository(old);
    expect(await g.checkout(dir)).toEqual({ top: dir, main: dir });
    expect(await g.checkout(join(dir, "src"))).toEqual({ top: dir, main: dir });
    const wt = join(await temp(), "shop-fix");
    git(dir, "worktree", "add", "-q", "-b", "fix", wt);
    expect(await g.checkout(wt)).toEqual({ top: wt, main: dir });
  });

  test("uncommitted: tracked and untracked files one by one, sorted, MetatorAI's state and ignored files aside", async () => {
    const dir = await temp();
    git(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.ts"), "a\n");
    await writeFile(join(dir, "c.ts"), "c\n");
    await writeFile(join(dir, ".gitignore"), "dist/\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    await writeFile(join(dir, "a.ts"), "changed\n");
    git(dir, "mv", "c.ts", "d.ts");
    await mkdir(join(dir, "new dir"), { recursive: true });
    await writeFile(join(dir, "new dir", "b é.ts"), "b\n");
    await mkdir(join(dir, ".metator"));
    await writeFile(join(dir, ".metator", "daemon.json"), "{}\n");
    await mkdir(join(dir, "dist"));
    await writeFile(join(dir, "dist", "x.js"), "x\n");
    const files = (await new GitCliRepository(runner).uncommitted(dir))._unsafeUnwrap();
    // A rename counts once, under its new name.
    expect(files).toEqual(["a.ts", "d.ts", "new dir/b é.ts"]);
    expect((await new GitCliRepository(runner).uncommitted(await temp())).isErr()).toBe(true);
  });

  test("commit: only the files named, the first commit too; what else was staged stays staged", async () => {
    const dir = await temp();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "T");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "commit.gpgsign", "false");
    await writeFile(join(dir, "metator.config.yml"), "kind: MetatorConfig\n");
    await writeFile(join(dir, "mine.ts"), "mine\n");
    await writeFile(join(dir, "staged.ts"), "staged\n");
    git(dir, "add", "staged.ts");
    const sha = (
      await new GitCliRepository(runner).commit(dir, ["metator.config.yml"], "Set up MetatorAI")
    )._unsafeUnwrap();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, "show", "--name-only", "--format=%s", "HEAD").trim().split("\n")).toEqual([
      "Set up MetatorAI",
      "",
      "metator.config.yml",
    ]);
    expect(git(dir, "status", "--porcelain").trim().split("\n")).toEqual(["A  staged.ts", "?? mine.ts"]);
  });

  test("commit: no files is refused; git without an identity says how to set one", async () => {
    const g = new GitCliRepository(
      new ScriptedProcessRunner([
        { argvPrefix: ["git", "add"], result: {} },
        {
          argvPrefix: ["git", "commit"],
          result: { exitCode: 128, stderr: "Author identity unknown\n*** Please tell me who you are." },
        },
      ]),
    );
    expect((await g.commit("/r", [], "x"))._unsafeUnwrapErr().code).toBe("USAGE");
    const e = (await g.commit("/r", ["a"], "x"))._unsafeUnwrapErr();
    expect(e.message).toContain("git commit failed");
    expect(e.hint).toContain("git config --global user.name");
  });
});
