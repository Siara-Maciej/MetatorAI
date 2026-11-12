/**
 * A run in its own worktree, as `run drive` gives one to its agents: the real `metator` process
 * in the worktree finds the run (the run directory is linked in), takes its own run when two
 * are open, and writes what the stage produces through `run write`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const FEATURE = `kind: Workflow
schemaVersion: 2
id: feature
stages:
  - id: intake
    owner: mt-orchestrator
    produces: [task.md]
  - id: build
    owner: mt-implementer
`;

let repo: ScratchRepo;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".github/metator/workflows/feature.yml", FEATURE);
  await repo.write("src/app.ts", "export const app = 1;\n");
  await repo.commit("init");
}, 60_000);

afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

describe("a run's worktree", () => {
  test("finds its own run, writes the stage's artifact, and stays clean for git", async () => {
    const first = data(
      await metator(["run", "init", "--workflow", "feature", "--task", "first", "--worktree"], repo.root),
    );
    const id = first.runId as string;
    const wt = join(repo.root, (first.worktree as { path: string }).path);
    // A second run becomes the latest; the first worktree keeps working on its own.
    await metator(["run", "init", "--workflow", "feature", "--task", "second"], repo.root);
    expect(data(await metator(["run", "status"], wt)).runId).toBe(id);

    const written = await metator(["run", "write", "task.md"], wt, {}, "# Task\n\nfirst\n");
    expect(data(written)).toMatchObject({ runId: id, file: `.metator/runs/${id}/task.md` });
    expect(await repo.read(`.metator/runs/${id}/task.md`)).toBe("# Task\n\nfirst\n");
    const refused = await metator(["run", "write", "plan.json"], wt, {}, "{}");
    expect([refused.code, (refused.json.error as { hint: string }).hint]).toEqual([
      64,
      "It produces: task.md.",
    ]);

    // The run directory is linked into the worktree and ignored by git there.
    expect(await Bun.file(join(wt, `.metator/runs/${id}/task.md`)).text()).toBe("# Task\n\nfirst\n");
    const status = Bun.spawnSync(["git", "status", "--porcelain", "--", ".metator/runs"], { cwd: wt });
    expect(status.stdout.toString()).toBe("");
  }, 60_000);

  test("four runs started at once each get a worktree in the registry and their own ports (R4)", async () => {
    const before = (
      JSON.parse(await repo.read(".metator/worktrees.json")) as { worktrees: { id: string }[] }
    ).worktrees.map((w) => w.id);
    const started = await Promise.all(
      ["one", "two", "three", "four"].map((n) =>
        metator(
          ["run", "init", "--workflow", "feature", "--task", `At once ${n}`, "--worktree", "--no-setup"],
          repo.root,
        ),
      ),
    );
    expect(started.map((s) => s.code)).toEqual([0, 0, 0, 0]);
    const ids = started.map((s) => (data(s).worktree as { id: string }).id);
    const registry = JSON.parse(await repo.read(".metator/worktrees.json")) as {
      worktrees: { id: string; ports: { from: number; count: number } }[];
    };
    expect(registry.worktrees.map((w) => w.id).sort()).toEqual([...before, ...ids].sort());
    const blocks = registry.worktrees.map((w) => w.ports.from);
    expect(new Set(blocks).size).toBe(blocks.length);
    // No lock is left behind.
    expect(await repo.exists(".metator/worktrees.json.lock")).toBe(false);
  }, 120_000);

  test("two approvals given at once are both in state.json and in the log (R5)", async () => {
    const run = data(
      await metator(["run", "init", "--workflow", "feature", "--task", "Two approvals"], repo.root),
    );
    const both = await Promise.all([
      metator(["run", "approve", "push", "--by", "maciej", "--run", run.runId as string], repo.root),
      metator(["run", "approve", "comment", "--by", "alice", "--run", run.runId as string], repo.root),
    ]);
    expect(both.map((b) => b.code)).toEqual([0, 0]);
    const state = JSON.parse(await repo.read(`.metator/runs/${run.runId}/state.json`)) as {
      approvals: Record<string, { by: string }>;
    };
    expect([state.approvals.push?.by, state.approvals.comment?.by]).toEqual(["maciej", "alice"]);
    const log = await repo.read(`.metator/runs/${run.runId}/log.md`);
    expect(log).toContain("approved push · by maciej");
    expect(log).toContain("approved comment · by alice");
  }, 60_000);

  test("a worktree without a config of its own reads the checkout's (one not committed yet)", async () => {
    await repo.write(
      "metator.config.yml",
      "kind: MetatorConfig\nschemaVersion: 4\nhosts:\n  targets: [claude]\n",
    );
    const first = data(
      await metator(["run", "init", "--workflow", "feature", "--task", "config", "--worktree"], repo.root),
    );
    const wt = join(repo.root, (first.worktree as { path: string }).path);
    const shown = data(await metator(["config", "show"], wt));
    expect(shown.source).toBe("metator.config.yml");
  }, 60_000);

  test("an escalated run resumes where it stopped, once a person says so", async () => {
    const id = data(await metator(["run", "init", "--workflow", "feature", "--task", "resume"], repo.root))
      .runId as string;
    await metator(["run", "advance", "fail", "--reason", "blocked", "--run", id], repo.root);
    expect(data(await metator(["run", "status", "--run", id], repo.root)).status).toBe("escalated");
    const back = await metator(["run", "resume", "--run", id, "--by", "ala"], repo.root);
    expect([back.code, data(back).stage, data(back).status]).toEqual([0, "intake", "active"]);
    const again = await metator(["run", "resume", "--run", id, "--by", "ala"], repo.root);
    expect([again.code, (again.json.error as { code: string }).code]).toEqual([64, "USAGE"]);
  }, 60_000);
});
