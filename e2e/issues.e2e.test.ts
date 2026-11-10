/**
 * The backlog end to end (S4): the real `metator issue` on a real temp repository. A person adds
 * a task; an agent's proposal is a question of its run that the person answers (from the inbox or
 * with `issue decide`); `issue start` makes a run on the task; the daemon serves the same list.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

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
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator issue (real CLI)", () => {
  test("a person adds; an agent proposes and the inbox decides; a decided task starts a run", async () => {
    const added = data(
      await mt(
        "issue",
        "add",
        "ADR for rounding",
        "--body",
        "Half-up or half-even.",
        "--priority",
        "high",
        "--labels",
        "adr,billing",
        "--by",
        "maciej",
      ),
    );
    expect(added).toMatchObject({ id: "i001", status: "open", priority: "high", labels: ["adr", "billing"] });
    expect(JSON.parse(await repo.read(".metator/issues/i001.json"))).toMatchObject({
      kind: "Issue",
      schemaVersion: 1,
      id: "i001",
    });
    const proposed = data(
      await mt(
        "issue",
        "propose",
        "Negative amounts in round2",
        "--body",
        "half-down for negatives",
        "--agent",
        "mt-implementer-1",
        "--run",
        runId,
        "--ref",
        "src/invoice.ts:10",
        `run:${runId}/S2`,
      ),
    ) as { issue: Data; questionId: string };
    expect(proposed.issue).toMatchObject({ id: "i002", status: "proposed" });
    expect(proposed.issue.refs).toEqual([
      { file: "src/invoice.ts", line: 10 },
      { run: runId, step: "S2" },
    ]);
    // The proposal is the run's question, in the inbox, with the agent's name.
    const questions = data(await mt("run", "questions", "--run", runId)) as { questions: Data[] };
    expect(questions.questions.map((q) => [q.id, q.source, q.agent])).toEqual([
      [proposed.questionId, "agent", "mt-implementer-1"],
    ]);
    const inbox = data(await mt("inbox")) as {
      decisions: { question: { prompt: string; options: { label: string }[] } }[];
    };
    expect(inbox.decisions[0]?.question.prompt).toBe(
      "mt-implementer-1 proposes a task: Negative amounts in round2",
    );
    expect(inbox.decisions[0]?.question.options.map((o) => o.label)).toEqual([
      "Add to the backlog",
      "Add and start a run",
      "Drop",
      "Other",
    ]);
    // A proposal cannot be started: the person decides first.
    expect((await mt("issue", "start", "i002", "--workflow", "demo")).json.error).toMatchObject({
      code: "USAGE",
    });
    expect(
      (
        await mt(
          "run",
          "answer",
          proposed.questionId,
          "--run",
          runId,
          "--choice",
          "Add to the backlog",
          "--by",
          "maciej",
        )
      ).code,
    ).toBe(0);
    expect(data(await mt("issue", "show", "i002"))).toMatchObject({
      status: "open",
      decidedBy: { by: "maciej", decision: "added" },
    });
    // Another proposal, decided from the CLI as dropped.
    const second = data(
      await mt("issue", "propose", "Edge test 1000.00", "--agent", "mt-plan-critic", "--run", runId),
    ) as { issue: Data };
    expect(
      data(await mt("issue", "decide", second.issue.id as string, "--drop", "--by", "maciej")),
    ).toMatchObject({ status: "dropped" });
    // The list, the most pressing first; filtered by status and by run.
    const list = data(await mt("issue", "list")) as { issues: Data[] };
    expect(list.issues.map((i) => [i.id, i.status])).toEqual([
      ["i001", "open"],
      ["i002", "open"],
      ["i003", "dropped"],
    ]);
    expect((data(await mt("issue", "list", "--status", "open")) as { issues: Data[] }).issues).toHaveLength(
      2,
    );
    expect(
      (data(await mt("issue", "list", "--run", runId)) as { issues: Data[] }).issues.map((i) => i.id),
    ).toEqual(["i002", "i003"]);
    // Start: a run whose task is the issue; the issue is in progress and points at the run.
    const started = data(await mt("issue", "start", "i001", "--workflow", "demo", "--no-worktree")) as {
      issue: Data;
      runId: string;
    };
    expect(started.issue).toMatchObject({ status: "in-progress", runId: started.runId });
    expect(data(await mt("run", "status", "--run", started.runId)).task).toBe(
      "ADR for rounding\n\nHalf-up or half-even.",
    );
    expect((await mt("issue", "close", "i001", "--by", "maciej")).code).toBe(0);
    const fourth = data(await mt("issue", "add", "Old TODO", "--by", "maciej"));
    expect(data(await mt("issue", "drop", fourth.id as string, "--by", "maciej"))).toMatchObject({
      status: "dropped",
    });
    expect(
      data(await mt("issue", "edit", "i002", "--priority", "low", "--labels", "billing,correctness")),
    ).toMatchObject({
      priority: "low",
      labels: ["billing", "correctness"],
    });
  }, 60_000);

  test("the daemon serves and changes the same backlog", async () => {
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
      const call = async (path: string, body?: unknown) =>
        (await (
          await fetch(
            `${base}${path}`,
            body
              ? {
                  method: "POST",
                  body: JSON.stringify(body),
                  headers: { "content-type": "application/json" },
                }
              : {},
          )
        ).json()) as { ok: boolean; data: Data; error?: Data };
      const list = await call("/issues");
      expect((list.data.issues as Data[]).map((i) => i.id)).toEqual(["i002", "i001", "i003", "i004"]);
      const added = await call("/issues", {
        title: "Flaky checkout.spec",
        by: "maciej",
        labels: ["tests"],
        refs: [{ file: "e2e/checkout.spec.ts" }],
      });
      expect(added.data).toMatchObject({ id: "i005", status: "open", labels: ["tests"] });
      expect((await call("/issues/i005/edit", { priority: "high" })).data).toMatchObject({
        priority: "high",
      });
      expect((await call("/issues/i005/drop", { by: "maciej" })).data).toMatchObject({ status: "dropped" });
      const refused = await call("/issues", { title: "", by: "maciej" });
      expect(refused.ok).toBe(false);
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
  }, 60_000);
});
