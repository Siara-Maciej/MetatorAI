/**
 * Workflow runs end to end: a real git repository, a workflow spec in YAML, and every step as a
 * separate `metator` process. Proves the state machine persists, resumes, enforces human gates,
 * bounds loops and leaves an audit trail on disk.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const FEATURE = `
kind: Workflow
schemaVersion: 1
id: feature
revision: 2
description: Feature workflow used by the e2e suite
stages:
  - id: context
  - id: plan
  - id: plan-gate
    onFail: { goto: plan, loop: plan }
  - id: approval
    hitl: true
  - id: build
  - id: review
    onFail: { goto: plan, loop: review }
loops:
  plan: 1
  review: 1
`;

const NOW = { METATOR_NOW: "2026-10-25T09:00:00.000Z" };
let repo: ScratchRepo;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".github/metator/workflows/feature.yml", FEATURE);
  await repo.write("src/app.ts", "export const app = 1;\n");
  await repo.commit("init");
});

afterAll(async () => {
  await repo.dispose();
});

const mt = (...args: string[]) => metator(args, repo.root, NOW);

describe("workflow catalog via CLI", () => {
  test("workflow list shows the spec with its stages", async () => {
    const r = await mt("workflow", "list");
    expect(r.code).toBe(0);
    expect(r.json.data).toEqual({
      workflows: [
        {
          id: "feature",
          revision: 2,
          stages: ["context", "plan", "plan-gate", "approval", "build", "review"],
          source: ".github/metator/workflows/feature.yml",
        },
      ],
    });
  });

  test("workflow schema prints a JSON Schema agents can use", async () => {
    const r = await mt("workflow", "schema");
    expect((r.json.data as { type: string }).type).toBe("object");
  });

  test("an invalid spec fails validation with paths, and list still works but warns", async () => {
    await repo.write(
      ".github/metator/workflows/broken.yml",
      "kind: Workflow\nschemaVersion: 1\nid: broken\nstages:\n  - id: a\n    onFail: { goto: nope, loop: x }\n",
    );
    try {
      const all = await mt("workflow", "validate");
      expect(all.code).toBe(1);
      expect(JSON.stringify(all.json)).toContain('unknown stage \\"nope\\"');

      const one = await mt("workflow", "validate", ".github/metator/workflows/feature.yml");
      expect(one.code).toBe(0);

      const list = await mt("workflow", "list");
      expect(list.code).toBe(0);
      expect((list.json.warnings as string[])[0]).toContain("broken.yml");
    } finally {
      await Bun.file(repo.path(".github/metator/workflows/broken.yml")).delete();
    }
  });
});

describe("run lifecycle via CLI (each step is a new process)", () => {
  let runId: string;

  test("init starts at the first stage and writes state.json + log.md", async () => {
    const r = await mt("run", "init", "--workflow", "feature", "--task", "Dodaj rabat łączony");
    expect(r.code).toBe(0);
    const data = r.json.data as {
      runId: string;
      stage: string;
      expects: string[];
      files: { state: string; log: string };
    };
    runId = data.runId;
    expect(runId).toBe("20261025-feature-dodaj-rabat-laczony");
    expect(data.stage).toBe("context");
    expect(data.expects).toEqual(["PASS", "FAIL", "ABORT"]);
    expect(await repo.exists(data.files.state)).toBe(true);
    expect(JSON.parse(await repo.read(".metator/runs/latest.json"))).toEqual({
      kind: "RunPointer",
      schemaVersion: 1,
      runId,
    });
  });

  test("advance moves through stages and status resumes from disk in a new process", async () => {
    expect((await mt("run", "advance", "pass")).json.data).toMatchObject({ stage: "plan" });
    expect((await mt("run", "advance", "pass")).json.data).toMatchObject({ stage: "plan-gate" });
    const status = await mt("run", "status");
    expect(status.json.data).toMatchObject({ runId, stage: "plan-gate", status: "active" });
  });

  test("a failed gate loops back once, then the loop limit is enforced", async () => {
    const back = await mt("run", "advance", "fail", "--reason", "plan lint: step 3 has no exemplar");
    expect(back.json.data).toMatchObject({ stage: "plan", loops: { plan: 1 } });
    await mt("run", "advance", "pass");
    const status = await mt("run", "status");
    expect(status.json.data).toMatchObject({ stage: "plan-gate" });
  });

  test("the human gate refuses PASS and refuses APPROVE without a name", async () => {
    await mt("run", "advance", "pass"); // plan-gate → approval
    const pass = await mt("run", "advance", "pass");
    expect(pass.code).toBe(1);
    expect(pass.json.error).toMatchObject({ code: "TRANSITION_DENIED" });
    expect((pass.json.error as { hint: string }).hint).toContain("APPROVE");

    const anonymous = await mt("run", "advance", "approve");
    expect(anonymous.code).toBe(64);
    expect((anonymous.json.error as { message: string }).message).toContain("--by");

    const status = await mt("run", "status");
    expect(status.json.data).toMatchObject({ stage: "approval", expects: ["APPROVE", "FAIL", "ABORT"] });
  });

  test("run approve: an action is recorded in place; the current HITL stage is approved and advances", async () => {
    const push = await mt("run", "approve", "push", "--by", "maciej");
    expect(push.json.data).toMatchObject({ runId, approvals: { push: { by: "maciej" } } });
    const wrong = await mt("run", "approve", "build", "--by", "maciej");
    expect([wrong.code, (wrong.json.error as { code: string }).code]).toEqual([64, "USAGE"]);
    expect((await mt("run", "approve", "push")).code).toBe(64); // --by is required

    const approved = await mt("run", "approve", "approval", "--by", "maciej", "--choice", "1");
    expect(approved.json.data).toMatchObject({
      stage: "build",
      approvals: { approval: { by: "maciej", choice: "1" }, push: { by: "maciej" } },
    });
    const state = JSON.parse(await repo.read(`.metator/runs/${runId}/state.json`));
    expect([state.schemaVersion, Object.keys(state.approvals).sort()]).toEqual([7, ["approval", "push"]]);
  });

  test("finishing the last stage completes the run", async () => {
    await mt("run", "advance", "pass");
    const done = await mt("run", "advance", "pass", "--run", runId);
    expect(done.json.data).toMatchObject({ stage: "done", status: "done", expects: [] });
    const after = await mt("run", "advance", "pass");
    expect(after.json.error).toMatchObject({ code: "TRANSITION_DENIED" });
  });

  test("state.json and log.md form a complete audit trail", async () => {
    const state = JSON.parse(await repo.read(`.metator/runs/${runId}/state.json`));
    expect(state.workflow).toEqual({
      id: "feature",
      revision: 2,
      source: ".github/metator/workflows/feature.yml",
    });
    expect(
      state.state.context.history.map((h: { stage: string; event: string }) => `${h.stage}:${h.event}`),
    ).toEqual([
      "context:PASS",
      "plan:PASS",
      "plan-gate:FAIL",
      "plan:PASS",
      "plan-gate:PASS",
      "approval:APPROVE",
      "build:PASS",
      "review:PASS",
    ]);
    const log = await repo.read(`.metator/runs/${runId}/log.md`);
    expect(log).toContain("plan-gate · FAIL · plan lint: step 3 has no exemplar → plan");
    expect(log).toContain("approval · APPROVE · by maciej · choice 1 → build");
    expect(log).toContain("approved push · by maciej");
    expect(
      log
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("- ")),
    ).toHaveLength(10);
  });

  test("an exhausted loop escalates instead of looping forever", async () => {
    const init = await mt("run", "init", "--workflow", "feature", "--task", "loop forever");
    const id = (init.json.data as { runId: string }).runId;
    await mt("run", "advance", "pass");
    await mt("run", "advance", "pass");
    await mt("run", "advance", "fail"); // uses the only retry
    await mt("run", "advance", "pass");
    const escalated = await mt("run", "advance", "fail", "--reason", "still broken");
    expect(escalated.json.data).toMatchObject({ runId: id, status: "escalated", expects: [] });
  }, 30_000); // many CLI processes in a row

  test("abort needs a reason and ends the run", async () => {
    await mt("run", "init", "--workflow", "feature", "--task", "to abort");
    expect((await mt("run", "advance", "abort")).code).toBe(64);
    const aborted = await mt("run", "advance", "abort", "--reason", "requirements changed");
    expect(aborted.json.data).toMatchObject({ status: "aborted" });
  });

  test("run list shows every run, newest first", async () => {
    const r = await mt("run", "list");
    const rows = r.json.data as { runId: string; status: string }[];
    expect(rows.map((x) => x.status).sort()).toEqual(["aborted", "done", "escalated"]);
  });

  test("a hand-edited state.json is rejected", async () => {
    const file = `.metator/runs/${runId}/state.json`;
    const original = await repo.read(file);
    try {
      await repo.write(
        file,
        original
          .replace('"stage": "done"', '"stage": "build"')
          .replace('"status": "done"', '"status": "weird"'),
      );
      const r = await mt("run", "status", "--run", runId);
      expect(r.code).toBe(1);
      expect(r.json.error).toMatchObject({ code: "INVALID_ARTIFACT" });
    } finally {
      await repo.write(file, original);
    }
  });
});

describe("a run's files stay readable (R1, R2)", () => {
  test("an approval or an answer without a name is refused and the record stays readable", async () => {
    const run = (await mt("run", "init", "--workflow", "feature", "--task", "who decided")).json.data as {
      runId: string;
    };
    const file = `.metator/runs/${run.runId}/state.json`;
    const before = await repo.read(file);
    const refused = await mt("run", "approve", "push", "--by", "", "--run", run.runId);
    expect([refused.code, (refused.json.error as { code: string }).code]).toEqual([64, "USAGE"]);
    expect((refused.json.error as { message: string }).message).toBe("say who approves: --by <name>");
    expect(await repo.read(file)).toBe(before);
    expect((await mt("run", "status", "--run", run.runId)).code).toBe(0);
    expect((await mt("run", "list")).code).toBe(0);
  }, 30_000);

  test("one truncated state.json: list, status, inbox, revive and doctor go on and name the file", async () => {
    const run = (await mt("run", "init", "--workflow", "feature", "--task", "torn record")).json.data as {
      runId: string;
    };
    const file = `.metator/runs/${run.runId}/state.json`;
    const original = await repo.read(file);
    try {
      await repo.write(file, original.slice(0, 60));
      const list = await mt("run", "list");
      const rows = list.json.data as { runId: string }[];
      expect(list.code).toBe(0);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.runId)).not.toContain(run.runId);
      const warnings = list.json.warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`run ${run.runId} cannot be read and is left out`);
      expect(warnings[0]).toContain(`restore ${file} (from git or a backup), or delete the run's directory`);
      const status = await mt("status");
      expect(status.code).toBe(0);
      const overview = status.json.data as { runs: unknown[]; unreadable: { runId: string; file: string }[] };
      expect(overview.runs.length).toBe(rows.length);
      expect(overview.unreadable.map((u) => [u.runId, u.file])).toEqual([[run.runId, file]]);
      expect(status.json.warnings).toEqual(warnings);
      for (const command of [["inbox"], ["run", "revive"]]) {
        const r = await mt(...command);
        expect([r.code, r.json.warnings]).toEqual([0, warnings]);
      }
      const doctor = await mt("doctor");
      const checks = (doctor.json.data as { checks: { id: string; message: string; fix?: string }[] }).checks;
      expect(checks.find((c) => c.id === "runs")).toMatchObject({
        status: "warn",
        fix: `restore ${file} (from git or a backup), or delete the run's directory`,
      });
      // The run a person names is still their answer: it cannot be read.
      expect((await mt("run", "status", "--run", run.runId)).code).toBe(1);
    } finally {
      await repo.write(file, original);
    }
  }, 60_000);

  test("a torn line in activity.jsonl is skipped: the activity before and after it still reads", async () => {
    const run = (await mt("run", "init", "--workflow", "feature", "--task", "torn line")).json.data as {
      runId: string;
    };
    await mt("run", "attach", "--by", "maciej", "--run", run.runId);
    const file = `.metator/runs/${run.runId}/activity.jsonl`;
    await repo.write(file, `${await repo.read(file)}{"kind":"RunActivity","schemaVersion":1,"at":"2026-1\n`);
    await mt("run", "release", "--run", run.runId);
    const activity = await mt("run", "activity", "--run", run.runId);
    expect(activity.code).toBe(0);
    expect(JSON.stringify(activity.json.data)).toContain("maciej attached");
    expect(JSON.stringify(activity.json.data)).toContain("maciej released");
    expect((await mt("run", "brief", "--run", run.runId)).code).toBe(0);
    // The versioned-files guard below reads JSON documents, not JSON Lines: this journal is done with.
    await rm(repo.path(file));
  }, 30_000);
});

describe("usage errors via CLI", () => {
  test("missing required options and unknown events are usage errors (exit 64)", async () => {
    expect((await mt("run", "init", "--task", "x")).code).toBe(64);
    expect((await mt("run", "init", "--workflow", "feature", "--task", "x", "--autonomy", "L9")).code).toBe(
      64,
    );
    expect((await mt("run", "advance", "skip")).code).toBe(64);
  });

  test("unknown workflow is NOT_FOUND and names the known ones", async () => {
    const r = await mt("run", "init", "--workflow", "nope", "--task", "x");
    expect(r.code).toBe(1);
    expect((r.json.error as { hint: string }).hint).toContain("feature");
  });

  test("--root lets the CLI run from anywhere", async () => {
    const r = await metator(["--root", repo.root, "workflow", "list"], repo.parent(), NOW);
    expect(r.code).toBe(0);
    expect((r.json.data as { workflows: unknown[] }).workflows).toHaveLength(1);
  });

  test("running from a subdirectory finds the repository root", async () => {
    const r = await metator(["workflow", "list"], repo.path("src"), NOW);
    expect((r.json.data as { workflows: unknown[] }).workflows).toHaveLength(1);
  });
});

describe("every persisted file is a versioned document (ADR-0016)", () => {
  const DIRS = [".metator", ".github/metator"];

  test("all files under .metator/ and every workflow spec declare kind and schemaVersion", async () => {
    const { checked, unversioned } = await findUnversioned(repo.root, DIRS);
    expect(checked).toBeGreaterThan(5);
    expect(unversioned).toEqual([]);
  });

  test("the guard itself detects an unversioned artifact (tests the test)", async () => {
    await repo.write(".metator/runs/rogue.json", JSON.stringify({ runId: "x" }));
    await repo.write(".metator/runs/rogue.md", "# no front matter\n");
    try {
      expect((await findUnversioned(repo.root, DIRS)).unversioned).toEqual([
        ".metator/runs/rogue.json",
        ".metator/runs/rogue.md",
      ]);
    } finally {
      await Bun.file(repo.path(".metator/runs/rogue.json")).delete();
      await Bun.file(repo.path(".metator/runs/rogue.md")).delete();
    }
  });

  test("a workflow file without a header is rejected with the expected header", async () => {
    await repo.write(".github/metator/workflows/legacy.yml", "id: legacy\nstages: [{ id: a }]\n");
    try {
      const r = await mt("workflow", "validate", ".github/metator/workflows/legacy.yml");
      expect(r.code).toBe(1);
      expect(r.json.error).toMatchObject({
        code: "INVALID_CONFIG",
        hint: 'Expected "kind: Workflow" and "schemaVersion: 3" at the top of the document.',
      });
    } finally {
      await Bun.file(repo.path(".github/metator/workflows/legacy.yml")).delete();
    }
  });
});

describe("what a workflow declares holds via CLI: autonomy levels, required inputs, external actions, optional stages", () => {
  const DECLARED = `
kind: Workflow
schemaVersion: 3
id: declared
input:
  oneOf: [task_text]
  required: [scope]
autonomy: [L0, L1]
permissions: { edit: plan-scope, external: [comment] }
stages:
  - id: build
  - id: learn
    optional: true
  - id: wrap
`;
  let own: ScratchRepo;
  const run = (...args: string[]) => metator(args, own.root, NOW);
  const init = (...more: string[]) => run("run", "init", "--workflow", "declared", "--task", "t", ...more);

  beforeAll(async () => {
    own = await ScratchRepo.create();
    await own.write(".github/metator/workflows/declared.yml", DECLARED);
    await own.write(
      ".github/metator/workflows/headless.yml",
      DECLARED.replace("id: declared", "id: headless").replace("autonomy: [L0, L1]", "autonomy: [L1]"),
    );
    await own.commit("init");
  });
  afterAll(async () => {
    await own.dispose();
  });

  test("init refuses a level the workflow does not list and a run without a required input", async () => {
    const level = await init("--input", "scope=src", "--autonomy", "L2");
    expect([level.code, level.json.error]).toEqual([
      64,
      {
        code: "USAGE",
        message: "workflow declared does not support autonomy L2",
        hint: "Supported autonomy levels: L0, L1.",
      },
    ]);
    const input = await init();
    expect([input.code, input.json.error]).toEqual([
      64,
      {
        code: "USAGE",
        message: "workflow declared needs the input `scope`",
        hint: "Pass each with `--input <name>=<value>`, e.g. `--input scope=<value>`.",
      },
    ]);
    // Neither refusal left a run behind.
    expect((await run("run", "list")).json.data).toEqual([]);
  });

  test("without --autonomy a run starts at L0, or at the workflow's first level when it lists no L0", async () => {
    const started = await init("--input", "scope=src");
    expect([started.code, (started.json.data as { autonomy: string }).autonomy]).toEqual([0, "L0"]);
    const headless = await run(
      "run",
      "init",
      "--workflow",
      "headless",
      "--task",
      "h",
      "--input",
      "scope=src",
    );
    expect((headless.json.data as { autonomy: string }).autonomy).toBe("L1");
    expect((await run("run", "advance", "abort", "--reason", "only the level mattered")).code).toBe(0);
  });

  const declaredRun = async () =>
    ((await run("run", "list")).json.data as { runId: string; workflow: string }[]).find(
      (r) => r.workflow === "declared",
    )?.runId as string;

  test("an external action the workflow does not permit is refused", async () => {
    const id = await declaredRun();
    const push = await run("run", "approve", "push", "--by", "alice", "--run", id);
    expect([push.code, push.json.error]).toEqual([
      64,
      {
        code: "USAGE",
        message: "workflow declared does not permit push",
        hint: "External actions it permits: comment.",
      },
    ]);
    expect((await run("run", "approve", "comment", "--by", "alice", "--run", id)).code).toBe(0);
  });

  test("a failed optional stage is skipped and the log says so", async () => {
    const id = await declaredRun();
    expect((await run("run", "advance", "pass", "--run", id)).code).toBe(0);
    const skipped = await run("run", "advance", "fail", "--reason", "no lessons", "--run", id);
    expect([skipped.code, (skipped.json.data as { stage: string }).stage]).toEqual([0, "wrap"]);
    expect(await own.read(`.metator/runs/${id}/log.md`)).toContain(
      "· learn · FAIL · no lessons → wrap (optional stage skipped)",
    );
  });
});
