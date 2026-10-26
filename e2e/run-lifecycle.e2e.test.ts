/**
 * Workflow runs end to end: a real git repository, a workflow spec in YAML, and every step as a
 * separate `metator` process. Proves the state machine persists, resumes, enforces human gates,
 * bounds loops and leaves an audit trail on disk.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
    expect([state.schemaVersion, Object.keys(state.approvals).sort()]).toEqual([2, ["approval", "push"]]);
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
  });

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
        hint: 'Expected "kind: Workflow" and "schemaVersion: 1" at the top of the document.',
      });
    } finally {
      await Bun.file(repo.path(".github/metator/workflows/legacy.yml")).delete();
    }
  });
});
