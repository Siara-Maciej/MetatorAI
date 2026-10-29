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
