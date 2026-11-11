/**
 * The plan board end to end (S2): `metator run board` on a real run directory with a plan, a
 * worker's result, a gate report and activity, and the same board from the running daemon.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.json]
  - id: approval
    hitl: true
  - id: build
    owner: [mt-test-author, mt-implementer]
    produces: [build-log.md]
  - id: review
    owner: mt-pr-review
`;
const PLAN = {
  kind: "Plan",
  schemaVersion: 1,
  task: "Add the discount",
  scope: ["src/**"],
  steps: [
    {
      id: "S1",
      action: "create",
      path: "src/invoice.test.ts",
      intent: "tests first",
      rules: ["MT-TEST-001"],
    },
    { id: "S2", action: "modify", path: "src/invoice.ts", intent: "discount()", dependsOn: ["S1"] },
    { id: "S3", action: "modify", path: "src/pdf/export.ts", intent: "cents in the PDF" },
  ],
};

let repo: ScratchRepo;
let runId = "";
type Data = Record<string, unknown>;
const mt = (...args: string[]) => metator(args, repo.root);
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.commit("init");
  runId = data(await mt("run", "init", "--workflow", "demo", "--task", "Add the discount")).runId as string;
  const dir = `.metator/runs/${runId}`;
  await repo.write(`${dir}/plan.json`, JSON.stringify(PLAN, null, 2));
  await repo.write(
    `${dir}/results/mt-test-author-1.json`,
    JSON.stringify({
      kind: "WorkerResult",
      schemaVersion: 1,
      worker: "mt-test-author-1",
      stage: "build",
      agent: "mt-test-author",
      status: "done",
      summary: "3 tests, red for the right reason",
      artifacts: ["src/invoice.test.ts"],
      at: "2026-11-09T22:36:00.000Z",
    }),
  );
  await repo.write(
    ".metator/gates/quick.json",
    JSON.stringify({
      kind: "GateReport",
      schemaVersion: 1,
      gate: "quick",
      files: null,
      startedAt: "2026-11-09T22:37:00.000Z",
      passed: true,
      steps: [{ id: "lint", status: "pass", durationMs: 12 }],
    }),
  );
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator run board (real CLI)", () => {
  test("the board: stages, steps with their state from the results, artifacts, the gate, what comes next", async () => {
    // Walk the run into build so the stages have a history.
    expect((await mt("run", "advance", "pass", "--run", runId)).code).toBe(0);
    expect((await mt("run", "approve", "approval", "--run", runId, "--by", "maciej")).code).toBe(0);
    const board = data(await mt("run", "board", "--run", runId)) as {
      stage: string;
      stages: { id: string; state: string; owners: string[]; verdict?: string }[];
      plan: { done: number; steps: { id: string; state: string; worker?: { name: string } }[] };
      artifacts: { name: string; present: boolean; stage?: string }[];
      gates: { gate: string; passed: boolean }[];
      next: { id: string; owners: string[] }[];
      waiting: unknown[];
    };
    expect(board.stage).toBe("build");
    expect(board.stages.map((s) => [s.id, s.state])).toEqual([
      ["plan", "done"],
      ["approval", "done"],
      ["build", "current"],
      ["review", "next"],
    ]);
    expect(board.stages[1]?.verdict).toBe("APPROVE");
    expect(board.stages[2]?.owners).toEqual(["mt-test-author", "mt-implementer"]);
    expect(board.plan.done).toBe(1);
    expect(board.plan.steps.map((s) => [s.id, s.state, s.worker?.name ?? null])).toEqual([
      ["S1", "done", "mt-test-author-1"],
      ["S2", "todo", null],
      ["S3", "todo", null],
    ]);
    const present = Object.fromEntries(board.artifacts.map((a) => [a.name, a.present]));
    expect(present).toMatchObject({ "plan.json": true, "build-log.md": false, "task.md": false });
    expect(board.artifacts.find((a) => a.name === "build-log.md")?.stage).toBe("build");
    // The run's own bookkeeping is not an artifact of the work.
    for (const own of ["state.json", "log.md", "summary.json", "activity.jsonl"])
      expect(board.artifacts.find((a) => a.name === own)).toBeUndefined();
    expect(board.gates).toEqual([expect.objectContaining({ gate: "quick", passed: true })]);
    expect(board.next).toEqual([{ id: "review", owners: ["mt-pr-review"] }]);
    expect(board.waiting).toEqual([]);
    // A run without a plan has no steps and says so.
    const other = data(await mt("run", "init", "--workflow", "demo", "--task", "Nothing planned"))
      .runId as string;
    expect(data(await mt("run", "board", "--run", other)).plan).toBeUndefined();
    // The latest run is the default; an unknown run is NOT_FOUND.
    expect(data(await mt("run", "board")).runId).toBe(other);
    expect((await mt("run", "board", "--run", "20261109-nope")).json.error).toMatchObject({
      code: "NOT_FOUND",
    });
  }, 30_000);

  test("the daemon serves the same board", async () => {
    const daemon = Bun.spawn(
      ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"],
      {
        cwd: repo.root,
        env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const reader = daemon.stderr.getReader();
      let text = "";
      let base = "";
      const deadline = Date.now() + 20_000;
      while (!base && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        const line = text.split("\n").find((l) => l.includes('"serving"'));
        if (line) base = (JSON.parse(line) as { serving: { url: string } }).serving.url;
      }
      expect(base).not.toBe("");
      const r = (await (await fetch(`${base}/runs/${runId}/board?timeline=2`)).json()) as {
        ok: boolean;
        data: { plan: { done: number }; timeline: unknown[] };
      };
      expect(r.ok).toBe(true);
      expect(r.data.plan.done).toBe(1);
      expect(r.data.timeline.length).toBeLessThanOrEqual(2);
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
  }, 60_000);
});
