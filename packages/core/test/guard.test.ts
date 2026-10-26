import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { AgentCatalog } from "../src/application/agents.ts";
import {
  CheckpointRun,
  GuardPostEdit,
  GuardPreTool,
  GuardSessionStart,
  GuardStop,
  GuardSubagentOutput,
} from "../src/application/guard.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, ApproveRun, GetRunStatus, InitRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

const ROOT = "/repo";
const FEATURE =
  "kind: Workflow\nschemaVersion: 1\nid: feature\nstages:\n  - id: build\n  - id: approval\n    hitl: true\n";
const COORDINATOR = `---
kind: Agent
schemaVersion: 1
id: mt-orchestrator
role: coordinator
description: Runs the workflow and delegates every stage to workers.
tier: reasoning
capabilities: [read, agent]
---
`;
const SCOPE = (edit: string[]) =>
  JSON.stringify({ kind: "PlanScope", schemaVersion: 1, plan: "p", edit, shards: [] });

function world(files: Record<string, string> = {}, role?: string) {
  const fs = new InMemoryFileSystem({
    ".github/metator/workflows/feature.yml": FEATURE,
    "metator/agents/mt-orchestrator.md": COORDINATOR,
    "src/a.ts": "export const a = 1;\n",
    ...files,
  });
  const clock = new FixedClock(new Date("2026-10-26T10:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const status = new GetRunStatus(catalog, repo);
  const advance = new AdvanceRun(catalog, repo, clock);
  return {
    fs,
    repo,
    init: () => new InitRun(catalog, repo, clock).execute({ workflow: "feature", task: "t" }),
    advance,
    approve: new ApproveRun(advance, repo, clock),
    preTool: new GuardPreTool(status, repo, new AgentCatalog(fs, DEFAULT_PATHS), fs, ROOT, role),
    stop: new GuardStop(status),
    subagent: new GuardSubagentOutput(status, repo, fs),
    session: new GuardSessionStart(status, fs, DEFAULT_PATHS),
    checkpoint: new CheckpointRun(status, repo, () => clock.now().toISOString()),
  };
}
const decision = (r: unknown) =>
  (r as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } })
    .hookSpecificOutput;
const edit = (path: string, agent?: string) => ({
  tool_name: "Edit",
  tool_input: { file_path: `${ROOT}/${path}` },
  ...(agent ? { agent_type: agent } : {}),
});

describe("GuardPreTool", () => {
  test("free mode without runs; the active run's plan-scope.json decides edits", async () => {
    const w = world();
    expect(decision((await w.preTool.execute(edit("src/b.ts")))._unsafeUnwrap()).permissionDecision).toBe(
      "allow",
    );
    const run = (await w.init())._unsafeUnwrap();
    await w.fs.write(`${w.repo.runDir(run.runId)}/plan-scope.json`, SCOPE(["src/a.ts"]));
    expect(decision((await w.preTool.execute(edit("src/a.ts")))._unsafeUnwrap()).permissionDecision).toBe(
      "allow",
    );
    expect(decision((await w.preTool.execute(edit("src/b.ts")))._unsafeUnwrap()).permissionDecision).toBe(
      "deny",
    );
  });

  test("push waits for `run approve push`; a finished run is free mode again", async () => {
    const w = world();
    await w.init();
    const push = { tool_name: "Bash", tool_input: { command: "git push origin feature" } };
    expect(decision((await w.preTool.execute(push))._unsafeUnwrap()).permissionDecision).toBe("deny");
    await w.approve.execute({ gate: "push", by: "maciej" });
    expect(decision((await w.preTool.execute(push))._unsafeUnwrap()).permissionDecision).toBe("allow");
    await w.advance.execute({ event: { type: "ABORT", reason: "done" } });
    const force = { tool_name: "Bash", tool_input: { command: "git push --force" } };
    expect(decision((await w.preTool.execute(force))._unsafeUnwrap()).permissionDecision).toBe("deny");
    expect(decision((await w.preTool.execute(edit("anything.ts")))._unsafeUnwrap()).permissionDecision).toBe(
      "allow",
    );
  });

  test("coordinators are known from the canonical agents or METATOR_ROLE", async () => {
    const w = world();
    await w.init();
    expect(
      decision((await w.preTool.execute(edit("src/a.ts", "mt-orchestrator")))._unsafeUnwrap())
        .permissionDecision,
    ).toBe("deny");
    expect(
      decision((await w.preTool.execute(edit("src/a.ts", "mt-implementer")))._unsafeUnwrap())
        .permissionDecision,
    ).toBe("allow");
    const byEnv = world({}, "coordinator");
    await byEnv.init();
    expect(decision((await byEnv.preTool.execute(edit("src/a.ts")))._unsafeUnwrap()).permissionDecision).toBe(
      "deny",
    );
  });

  test("a broken plan-scope.json or state.json is an error value, not a silent allow", async () => {
    const w = world();
    const run = (await w.init())._unsafeUnwrap();
    await w.fs.write(`${w.repo.runDir(run.runId)}/plan-scope.json`, "{}");
    expect((await w.preTool.execute(edit("src/a.ts")))._unsafeUnwrapErr().code).toBe("INVALID_ARTIFACT");
    await w.fs.write(run.files.state, "{");
    expect((await w.preTool.execute(edit("src/a.ts")))._unsafeUnwrapErr().code).toBe("INVALID_ARTIFACT");
  });
});

describe("GuardStop", () => {
  test("blocks at a working stage, lets the agent stop to wait for a human, never loops", async () => {
    const w = world();
    expect((await w.stop.execute({}))._unsafeUnwrap()).toBeNull();
    await w.init();
    const blocked = (await w.stop.execute({}))._unsafeUnwrap() as { decision: string; reason: string };
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain("is at stage build (expects PASS, FAIL, ABORT)");
    expect((await w.stop.execute({ stop_hook_active: true }))._unsafeUnwrap()).toBeNull();
    await w.advance.execute({ event: { type: "PASS" } }); // → approval (HITL)
    expect((await w.stop.execute({}))._unsafeUnwrap()).toBeNull();
  });
});

describe("GuardSubagentOutput", () => {
  test("every JSON artifact of the active run must be a valid, known document", async () => {
    const w = world();
    const run = (await w.init())._unsafeUnwrap();
    const dir = w.repo.runDir(run.runId);
    expect((await w.subagent.execute({}))._unsafeUnwrap()).toBeNull();
    await w.fs.write(`${dir}/plan-scope.json`, SCOPE([]));
    await w.fs.write(
      `${dir}/findings/logic.json`,
      JSON.stringify({ kind: "FindingSet", schemaVersion: 1, lens: "logic" }),
    );
    await w.fs.write(`${dir}/notes.json`, JSON.stringify({ any: 1 }));
    await w.fs.write(`${dir}/broken.json`, "{");
    const out = (await w.subagent.execute({}))._unsafeUnwrap() as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("broken.json is not valid JSON");
    expect(out.reason).toContain("findings/logic.json: does not match FindingSet v1");
    expect(out.reason).toContain("notes.json: unknown or missing kind");
    expect(out.reason).not.toContain("plan-scope.json");
    expect((await w.subagent.execute({ stop_hook_active: true }))._unsafeUnwrap()).toBeNull();
  });

  test("context artifacts and the run summary are known documents", async () => {
    const w = world();
    const run = (await w.init())._unsafeUnwrap();
    const dir = w.repo.runDir(run.runId);
    const analysis = {
      kind: "Analysis",
      schemaVersion: 1,
      task: "t",
      entryFiles: [{ path: "src/a.ts" }],
      packages: [],
      affected: { files: ["src/a.ts"], tests: [] },
    };
    await w.fs.write(`${dir}/analysis.json`, JSON.stringify(analysis));
    await w.fs.write(
      `${dir}/research.json`,
      JSON.stringify({
        kind: "Research",
        schemaVersion: 1,
        exemplars: [{ need: "a use case", file: "src/a.ts" }],
      }),
    );
    expect((await w.subagent.execute({}))._unsafeUnwrap()).toBeNull();
    await w.fs.write(`${dir}/analysis.json`, JSON.stringify({ ...analysis, entryFiles: [] }));
    await w.fs.write(
      `${dir}/summary.json`,
      JSON.stringify({ kind: "RunSummary", schemaVersion: 1, runId: run.runId }),
    );
    const out = (await w.subagent.execute({}))._unsafeUnwrap() as { reason: string };
    expect(out.reason).toContain("name at least one entry file");
    expect(out.reason).toContain("summary.json: does not match RunSummary v1");
    expect(out.reason).not.toContain("research.json");
  });
});

describe("GuardSessionStart and CheckpointRun", () => {
  test("session start names a missing index and the active run", async () => {
    const w = world();
    const first = (await w.session.execute())._unsafeUnwrap() as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(first.hookSpecificOutput.additionalContext).toContain("metator index build");
    await w.fs.write(`${DEFAULT_PATHS.index}/imports.json`, "{}");
    expect((await w.session.execute())._unsafeUnwrap()).toBeNull();
    const run = (await w.init())._unsafeUnwrap();
    const ctx = (await w.session.execute())._unsafeUnwrap() as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(ctx.hookSpecificOutput.additionalContext).toContain(
      `Active run ${run.runId} (feature): stage build`,
    );
  });

  test("a checkpoint line summarizes stage, loops and approvals in log.md", async () => {
    const w = world();
    expect((await w.checkpoint.execute({}))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    const run = (await w.init())._unsafeUnwrap();
    await w.approve.execute({ gate: "push", by: "maciej" });
    const done = (await w.checkpoint.execute({}))._unsafeUnwrap();
    expect(done.line).toBe(
      "2026-10-26T10:00:00.000Z · checkpoint · build (active) · expects PASS, FAIL, ABORT · approved push",
    );
    expect((await w.fs.read(run.files.log))._unsafeUnwrap()).toContain(done.line);
  });
});

describe("GuardPostEdit", () => {
  const checks = (violations: unknown[]) => {
    const calls: unknown[] = [];
    return {
      calls,
      checkRules: {
        execute: async (input: unknown) => {
          calls.push(input);
          return ok({ engines: ["ast-grep"], files: 1, violations } as never);
        },
      },
    };
  };

  test("checks only edited files that exist, with the per-file engines, and reports problems as context", async () => {
    const fs = new InMemoryFileSystem({ "src/a.ts": "x" });
    const c = checks([
      {
        engine: "ast-grep",
        file: "src/a.ts",
        line: 3,
        severity: "error",
        message: "no throw",
        canonRuleId: "MT-CODE-001",
        source: "ast-grep",
      },
      { engine: "biome", file: "src/a.ts", severity: "info", message: "hint", source: "biome" },
    ]);
    const guard = new GuardPostEdit(c.checkRules, fs, ROOT);
    const out = (await guard.execute(edit("src/a.ts")))._unsafeUnwrap() as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(c.calls).toEqual([{ files: ["src/a.ts"], engines: ["ast-grep", "biome"] }]);
    expect(out.hookSpecificOutput.additionalContext).toContain("src/a.ts:3 MT-CODE-001: no throw");
    expect(out.hookSpecificOutput.additionalContext).toContain("found 1 problem(s)");
    expect((await guard.execute(edit("src/gone.ts")))._unsafeUnwrap()).toBeNull();
    expect(
      (
        await guard.execute({ tool_name: "Read", tool_input: { file_path: `${ROOT}/src/a.ts` } })
      )._unsafeUnwrap(),
    ).toBeNull();
  });

  test("clean files say nothing; a failing check is an error value", async () => {
    const fs = new InMemoryFileSystem({ "src/a.ts": "x" });
    expect(
      (await new GuardPostEdit(checks([]).checkRules, fs, ROOT).execute(edit("src/a.ts")))._unsafeUnwrap(),
    ).toBeNull();
    const failing = {
      execute: async () => err(new MetatorError("BIN_NOT_FOUND", "ast-grep is not installed")),
    };
    expect(
      (await new GuardPostEdit(failing, fs, ROOT).execute(edit("src/a.ts")))._unsafeUnwrapErr().code,
    ).toBe("BIN_NOT_FOUND");
  });
});
