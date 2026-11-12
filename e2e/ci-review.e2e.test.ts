/**
 * The CI review at autonomy L2, end to end: the approval gate of the review workflow is skipped
 * and grants `comment`, so the publish stage may post; at L0 the same post is denied until a
 * person approves. The real `metator` process and the real pre-tool hook on a real repository.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { hook, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
const POST = { tool_name: "Bash", tool_input: { command: "gh pr comment 12 --body 'One blocker'" } };

let repo: ScratchRepo;
const decision = (r: { json: Record<string, unknown> | null }) =>
  (r.json?.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  // The shipped workflow itself: what this test pins is the file CI runs.
  await repo.write(
    ".github/metator/workflows/mt-pr-review.yml",
    await Bun.file(join(SELF, ".github/metator/workflows/mt-pr-review.yml")).text(),
  );
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.commit("init");
});
afterAll(async () => repo.dispose());

const start = async (autonomy: string) => {
  const init = await metator(
    ["run", "init", "--workflow", "mt-pr-review", "--task", `Review at ${autonomy}`, "--autonomy", autonomy],
    repo.root,
  );
  expect(init.code).toBe(0);
  const runId = (init.json.data as { runId: string }).runId;
  // metadata, shard, rules, find, verify, judge: six stages before the approval gate.
  let stage = "";
  for (let i = 0; i < 6; i++) {
    const r = await metator(["run", "advance", "pass", "--run", runId], repo.root);
    expect(r.code).toBe(0);
    stage = (r.json.data as { stage: string }).stage;
  }
  return { runId, stage };
};

describe("mt-pr-review in CI (L2) may post its comments; with a person (L0) it asks first", () => {
  test("L2: the approval gate is skipped, comment is granted by the level, the hook lets the post through", async () => {
    const { runId, stage } = await start("L2");
    expect(stage).toBe("publish");
    const record = JSON.parse(await repo.read(`.metator/runs/${runId}/state.json`)) as {
      approvals: Record<string, { by: string }>;
    };
    expect([record.approvals.approval?.by, record.approvals.comment?.by]).toEqual([
      "autonomy L2",
      "autonomy L2",
    ]);
    expect(await repo.read(`.metator/runs/${runId}/log.md`)).toContain(
      "approved comment · by autonomy L2 (granted by approval)",
    );
    expect((await hook(["guard", "pre-tool"], POST, repo.root, { METATOR_RUN: runId })).json).toBeNull();
    // A push is never granted by a level.
    const push = { tool_name: "Bash", tool_input: { command: "git push origin HEAD" } };
    expect(decision(await hook(["guard", "pre-tool"], push, repo.root, { METATOR_RUN: runId }))).toBe("deny");
  }, 60_000);

  test("L0: the run waits at the gate and the post is denied until the gate is approved", async () => {
    const { runId, stage } = await start("L0");
    expect(stage).toBe("approval");
    const env = { METATOR_RUN: runId };
    expect(decision(await hook(["guard", "pre-tool"], POST, repo.root, env))).toBe("deny");
    expect(
      (await metator(["run", "approve", "approval", "--by", "ala", "--run", runId], repo.root)).code,
    ).toBe(0);
    expect((await hook(["guard", "pre-tool"], POST, repo.root, env)).json).toBeNull();
  }, 60_000);

  test("the shipped workflow passes workflow lint in a repository with the shipped agents", async () => {
    const lint = await metator(["workflow", "lint", "--root", SELF], SELF);
    expect([lint.code, (lint.json.data as { problems: unknown[] }).problems]).toEqual([0, []]);
  });
});
