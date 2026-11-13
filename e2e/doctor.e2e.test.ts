/**
 * `metator doctor` end to end (P2): on a real repository the CLI says what a run will not do
 * (no dependencies installed, no gates, no remote) and `run init` carries the same warnings, so
 * nobody learns it from a run whose gates checked only rules.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: build
    owner: mt-implementer
`;

let repo: ScratchRepo;
const mt = (...args: string[]) => metator(args, repo.root);
interface Check {
  id: string;
  status: string;
  fix?: string;
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nnode_modules/\n");
  await repo.write(
    "package.json",
    '{ "name": "demo", "scripts": { "test": "bun test" }, "devDependencies": { "left-pad": "1.3.0" } }\n',
  );
  await repo.write("bun.lock", "{}\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.commit("init");
});
afterAll(async () => repo.dispose());

describe("metator doctor (real CLI)", () => {
  test("a repository without dependencies, gates or a remote: ready, with what a run will not do", async () => {
    const r = await mt("doctor");
    expect(r.code).toBe(0);
    const data = r.json.data as { ready: boolean; checks: Check[] };
    expect(data.ready).toBe(true);
    expect(data.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      "config:warn",
      "canon:warn",
      "workflows:ok",
      "gates:warn",
      "host:ok",
      "dependencies:warn",
      "environment:ok",
      "mcp:ok",
      "remote:warn",
    ]);
    expect(data.checks.find((c) => c.id === "dependencies")?.fix).toBe("bun install");
    expect((r.json.warnings as string[]).length).toBe(5);
  });

  test("run init warns about an open question in the task and what this run cannot do; installed dependencies end that warning", async () => {
    const init = await mt(
      "run",
      "init",
      "--workflow",
      "demo",
      "--task",
      "Add a --verbose flag to the CLI. Should it also log timings?",
    );
    expect(init.code).toBe(0);
    expect((init.json.warnings as string[]).map((w) => w.split(":")[0])).toEqual([
      "task",
      "gates",
      "dependencies",
      "remote",
    ]);
    expect((init.json.warnings as string[])[0]).toContain("(Should it also log timings?)");
    await mkdir(repo.path("node_modules"));
    const after = await mt("doctor");
    const deps = (after.json.data as { checks: Check[] }).checks.find((c) => c.id === "dependencies");
    expect(deps?.status).toBe("ok");
  });

  test("a repository with no commit: doctor is not ready and names the fix, as worktree new and run init --worktree do", async () => {
    const fresh = await ScratchRepo.create();
    try {
      await fresh.write(".github/metator/workflows/demo.yml", WORKFLOW);
      const FIX = "git commit --allow-empty -m init";
      const r = await metator(["doctor"], fresh.root);
      const data = r.json.data as { ready: boolean; checks: Check[] };
      expect(data.ready).toBe(false);
      expect(data.checks.find((c) => c.id === "commits")).toMatchObject({ status: "fail", fix: FIX });
      for (const args of [
        ["worktree", "new", "x"],
        ["run", "init", "--workflow", "demo", "--task", "x", "--worktree"],
      ]) {
        const failed = await metator(args, fresh.root);
        expect([args[0], failed.code]).toEqual([args[0], 1]);
        expect([args[0], (failed.json.error as { hint: string }).hint]).toEqual([
          args[0],
          expect.stringContaining(FIX),
        ]);
      }
      // The fix works.
      await fresh.git("commit", "-q", "--allow-empty", "-m", "init");
      expect((await metator(["worktree", "new", "x"], fresh.root)).code).toBe(0);
    } finally {
      await fresh.dispose();
    }
  }, 60_000);

  test("without any workflow the repository is not ready", async () => {
    const empty = await ScratchRepo.create();
    try {
      await empty.write("README.md", "# x\n");
      await empty.commit("init");
      const r = await metator(["doctor"], empty.root);
      expect((r.json.data as { ready: boolean }).ready).toBe(false);
    } finally {
      await empty.dispose();
    }
  });

  test("a directory that is not a git repository: doctor is not ready and run init refuses with the fix (F3)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "metator-e2e-nogit-"));
    try {
      await Bun.write(join(dir, ".github/metator/workflows/demo.yml"), WORKFLOW);
      const FIX = "git init && git commit --allow-empty -m init";
      const r = await metator(["doctor"], dir);
      const data = r.json.data as { ready: boolean; checks: Check[] };
      expect(data.ready).toBe(false);
      expect(data.checks.find((c) => c.id === "git")).toMatchObject({ status: "fail", fix: FIX });
      for (const more of [[], ["--worktree"]]) {
        const init = await metator(["run", "init", "--workflow", "demo", "--task", "x", ...more], dir);
        const e = init.json.error as { code: string; hint: string };
        expect([init.code, e.code, e.hint]).toEqual([
          1,
          "CHECK_FAILED",
          `Run \`${FIX}\`, then start the run again.`,
        ]);
      }
      expect((await metator(["run", "list"], dir)).json.data).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("uncommitted changes: doctor says so, run init --worktree refuses, --allow-dirty starts without them (F3)", async () => {
    await repo.write("package.json", '{ "name": "demo-changed" }\n');
    try {
      const doctor = (await mt("doctor")).json.data as {
        ready: boolean;
        checks: (Check & { message: string })[];
      };
      const tree = doctor.checks.find((c) => c.id === "tree");
      expect([doctor.ready, tree?.status]).toEqual([true, "warn"]);
      expect(tree?.message).toStartWith("1 tracked file(s) have uncommitted changes (package.json)");
      const args = [
        "run",
        "init",
        "--workflow",
        "demo",
        "--task",
        "Start from a dirty tree",
        "--worktree",
        "--no-setup",
      ];
      const refused = await mt(...args);
      const e = refused.json.error as { code: string; message: string; hint: string };
      expect([refused.code, e.code]).toEqual([1, "CHECK_FAILED"]);
      expect(e.message).toStartWith("the run would start without your changes: 1 tracked file(s)");
      expect(e.hint).toContain("--allow-dirty");
      // In the checkout the run starts, and is told what it will carry along.
      const here = await mt("run", "init", "--workflow", "demo", "--task", "Start here from a dirty tree");
      expect(here.code).toBe(0);
      expect((here.json.warnings as string[]).some((w) => w.startsWith("tree: "))).toBe(true);
      // An issue's run starts in a worktree by default: the same refusal, the same way past it.
      await mt("issue", "add", "Tidy the flags", "--by", "ola");
      const issue = await mt("issue", "start", "i001", "--workflow", "demo");
      expect((issue.json.error as { code: string }).code).toBe("CHECK_FAILED");
      expect((await mt("issue", "start", "i001", "--workflow", "demo", "--allow-dirty")).code).toBe(0);
      const allowed = await mt(...args, "--allow-dirty");
      expect(allowed.code).toBe(0);
      const wt = (allowed.json.data as { worktree: { path: string } }).worktree.path;
      expect(await repo.read(`${wt}/package.json`)).toContain('"name": "demo"');
    } finally {
      await repo.git("checkout", "--", "package.json");
    }
  }, 60_000);

  test("no AI host that can start: doctor is not ready; a workflow that is not installed names metator setup (F3)", async () => {
    await repo.write(
      "metator.config.yml",
      "kind: MetatorConfig\nschemaVersion: 1\nhosts:\n  targets: [copilot]\n",
    );
    try {
      const r = await metator(["doctor"], repo.root, { METATOR_COPILOT_BIN: repo.path("no-such-copilot") });
      const data = r.json.data as { ready: boolean; checks: (Check & { message: string })[] };
      const host = data.checks.find((c) => c.id === "host");
      expect([data.ready, host?.status]).toEqual([false, "fail"]);
      expect(host?.message).toStartWith("no AI host can start: copilot (");
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(repo.path("metator.config.yml"), { force: true });
    }
    const empty = await ScratchRepo.create();
    try {
      await empty.write("README.md", "# x\n");
      await empty.commit("init");
      const init = await metator(["run", "init", "--workflow", "mt-feature", "--task", "x"], empty.root);
      expect((init.json.error as { hint: string }).hint).toStartWith(
        "No workflow is installed here: run `metator setup`",
      );
    } finally {
      await empty.dispose();
    }
  }, 60_000);

  test("workflow preconditions: a dirty tree, a detached HEAD and a red quick gate refuse the run with the fix; doctor --gates says the gate is red", async () => {
    const pre = await ScratchRepo.create();
    const wf = (id: string, preconditions: string) =>
      `kind: Workflow\nschemaVersion: 3\nid: ${id}\npreconditions: ${preconditions}\nstages:\n  - id: build\n    owner: mt-implementer\n`;
    try {
      await pre.write(".gitignore", ".metator/\n");
      await pre.write(
        "package.json",
        JSON.stringify({
          name: "pre",
          scripts: { test: "test ! -f RED || (echo two tests failed; exit 1)" },
        }),
      );
      await pre.write(
        "metator.config.yml",
        "kind: MetatorConfig\nschemaVersion: 2\ngates:\n  quick:\n    - id: test\n      run: { script: test }\n",
      );
      await pre.write(".github/metator/workflows/tidy.yml", wf("tidy", "[clean-tree, branch-ok]"));
      await pre.write(".github/metator/workflows/green.yml", wf("green", "[tests-green]"));
      await pre.write(".github/metator/workflows/odd.yml", wf("odd", "[index-fresh]"));
      await pre.write(".github/metator/workflows/free.yml", wf("free", "[]"));
      await pre.commit("init");
      const init = (workflow: string, ...more: string[]) =>
        metator(["run", "init", "--workflow", workflow, "--task", "x", ...more], pre.root);
      const error = (r: { json: Record<string, unknown> }) =>
        r.json.error as { code: string; message: string; hint: string; details: { precondition: string } };

      // clean-tree: refused in the checkout; the other workflow starts; --allow-dirty is a decision.
      await pre.write("package.json", `${await pre.read("package.json")}\n`);
      const dirty = await init("tidy");
      expect([dirty.code, error(dirty).code, error(dirty).details]).toEqual([
        1,
        "CHECK_FAILED",
        { precondition: "clean-tree" },
      ]);
      expect(error(dirty).message).toStartWith(
        "precondition clean-tree does not hold (no tracked file has uncommitted changes): 1 tracked file(s)",
      );
      expect(error(dirty).hint).toContain("git stash");
      expect((await init("free")).code).toBe(0);
      expect((await init("tidy", "--allow-dirty")).code).toBe(0);
      await pre.git("checkout", "--", "package.json");

      // branch-ok: a detached HEAD refuses a run in the checkout; doctor says it; a branch fixes it.
      await pre.git("checkout", "-q", "--detach");
      const detached = await init("tidy");
      expect(error(detached).details).toEqual({ precondition: "branch-ok" });
      expect(error(detached).hint).toContain("git switch -c <branch>");
      const doctor = (await metator(["doctor"], pre.root)).json.data as { checks: Check[] };
      expect(doctor.checks.find((c) => c.id === "branch")).toMatchObject({ status: "warn" });
      await pre.git("switch", "-q", "main");
      expect((await init("tidy")).code).toBe(0);

      // tests-green: the quick gate runs when the run starts.
      expect((await init("green")).code).toBe(0);
      await pre.write("RED", "");
      const red = await init("green");
      expect(error(red).details).toEqual({ precondition: "tests-green" });
      expect(error(red).message).toContain("step test failed (test: two tests failed)");
      expect(error(red).hint).toStartWith("Run `metator gate quick`");
      // doctor: nothing about the gate unless asked; asked, the failing step and the command.
      const plain = (await metator(["doctor"], pre.root)).json.data as { checks: Check[] };
      expect(plain.checks.some((c) => c.id === "green")).toBe(false);
      const asked = await metator(["doctor", "--gates"], pre.root);
      const green = (
        asked.json.data as { ready: boolean; checks: (Check & { message: string })[] }
      ).checks.find((c) => c.id === "green");
      expect([asked.code, green?.status, green?.fix]).toEqual([0, "warn", "metator gate quick"]);
      expect(green?.message).toContain("step test failed");
      expect((asked.json.warnings as string[]).some((w) => w.startsWith("green: "))).toBe(true);
      const { rm } = await import("node:fs/promises");
      await rm(pre.path("RED"));
      const now = (await metator(["doctor", "--gates"], pre.root)).json.data as { checks: Check[] };
      expect(now.checks.find((c) => c.id === "green")?.status).toBe("ok");

      // A precondition nothing can check: lint rejects it and no run starts on it.
      const odd = await init("odd");
      expect(error(odd).message).toContain("`index-fresh`, which nothing can check");
      const lint = await metator(["workflow", "lint"], pre.root);
      expect(JSON.stringify(lint.json)).toContain("`index-fresh` cannot be checked when a run starts");
    } finally {
      await pre.dispose();
    }
  }, 120_000);
});
