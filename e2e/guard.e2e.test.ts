/**
 * Hooks end to end: the real `metator guard *` processes get real hook payloads on stdin in a
 * real git repository with a real run, plan scope and ast-grep rules, and `generate` writes the
 * hook configuration both hosts read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { hook, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
const WORKFLOW = `kind: Workflow
schemaVersion: 1
id: feature
stages:
  - id: build
  - id: delivery
    hitl: true
`;
const RULES = `kind: RuleSet
schemaVersion: 1
area: CODE
rules:
  - id: ACME-CODE-001
    title: No var
    applyTo: ["src/**"]
    enforcement: E1
    implementation: ast-grep:no-var
    summary: Use const or let.
    rationale: README.md
    source: { ref: README.md, verified: 2026-10-26 }
`;
const NO_VAR =
  'id: no-var\nlanguage: TypeScript\nseverity: error\nmessage: "use const"\nrule:\n  pattern: var $A = $B\n';

let repo: ScratchRepo;
let runId: string;
const contextOf = (r: { json: Record<string, unknown> | null }) =>
  String((r.json?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext);
const decision = (r: { json: Record<string, unknown> | null }) =>
  r.json?.hookSpecificOutput as
    | { hookEventName?: string; permissionDecision: string; permissionDecisionReason: string }
    | undefined;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", "node_modules/\n.metator/\n");
  await repo.write("README.md", "# acme\n");
  await repo.write(".github/metator/workflows/feature.yml", WORKFLOW);
  await repo.write("docs/metator/rules/code.yml", RULES);
  await repo.write("sgconfig.yml", "ruleDirs: [rules]\ntestConfigs:\n  - testDir: rule-tests\n");
  await repo.write("rules/no-var.yml", NO_VAR);
  await repo.write("rule-tests/no-var-test.yml", "id: no-var\nvalid: [const a = 1]\ninvalid: [var a = 1]\n");
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.write(".env", "TOKEN=secret\n");
  await repo.commit("init");
  await mkdir(repo.path("node_modules/.bin"), { recursive: true });
  await symlink(join(SELF, "node_modules/.bin/ast-grep"), repo.path("node_modules/.bin/ast-grep"));
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator guard (real hook processes)", () => {
  test("free mode: secrets and destructive commands are denied, the rest allowed; exit is always 0", async () => {
    const env = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Read", tool_input: { file_path: repo.path(".env") } },
      repo.root,
    );
    expect([env.code, decision(env)?.permissionDecision]).toEqual([0, "deny"]);
    const reset = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Bash", tool_input: { command: "git reset --hard" } },
      repo.root,
    );
    expect(decision(reset)?.permissionDecision).toBe("deny");
    const push = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Bash", tool_input: { command: "git push" } },
      repo.root,
    );
    expect(decision(push)).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "no active run",
    });
    expect((await hook(["guard", "stop"], {}, repo.root)).json).toBeNull();
  });

  test("in a run: plan scope, push approval and stop are enforced", async () => {
    const init = await metator(["run", "init", "--workflow", "feature", "--task", "guarded"], repo.root);
    runId = (init.json.data as { runId: string }).runId;
    await repo.write(
      `.metator/runs/${runId}/plan-scope.json`,
      JSON.stringify({ kind: "PlanScope", schemaVersion: 1, plan: "p", edit: ["src/a.ts"], shards: [] }),
    );
    const inside = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Edit", tool_input: { file_path: repo.path("src/a.ts") } },
      repo.root,
    );
    expect(decision(inside)?.permissionDecision).toBe("allow");
    const outside = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Write", tool_input: { file_path: repo.path("src/b.ts") } },
      repo.root,
    );
    expect(decision(outside)?.permissionDecisionReason).toContain("outside plan-scope.json");
    const coordinator = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Edit", tool_input: { file_path: repo.path("src/a.ts") } },
      repo.root,
      { METATOR_ROLE: "coordinator" },
    );
    expect(decision(coordinator)?.permissionDecision).toBe("deny");

    const push = { tool_name: "Bash", tool_input: { command: "git push origin feature" } };
    expect(decision(await hook(["guard", "pre-tool"], push, repo.root))?.permissionDecision).toBe("deny");
    await metator(["run", "approve", "push", "--by", "maciej"], repo.root);
    expect(decision(await hook(["guard", "pre-tool"], push, repo.root))?.permissionDecision).toBe("allow");

    const stop = await hook(["guard", "stop"], { stop_hook_active: false }, repo.root);
    expect(stop.json).toMatchObject({ decision: "block" });
    expect(String(stop.json?.reason)).toContain("stage build");
    expect((await hook(["guard", "stop"], { stop_hook_active: true }, repo.root)).json).toBeNull();
  }, 30_000); // ten hook processes

  test("post-edit reports the edited file's rule violations as context; clean files say nothing", async () => {
    const payload = { tool_name: "Edit", tool_input: { file_path: repo.path("src/a.ts") } };
    expect((await hook(["guard", "post-edit"], payload, repo.root)).json).toBeNull();
    await repo.write("src/a.ts", "var a = 1;\n");
    const out = await hook(["guard", "post-edit"], payload, repo.root);
    expect(contextOf(out)).toContain("src/a.ts:1 ACME-CODE-001: use const");
    await repo.write("src/a.ts", "export const a = 1;\n");
  });

  test("subagent-output blocks on an invalid artifact; precompact writes a checkpoint; session-start resumes", async () => {
    await repo.write(`.metator/runs/${runId}/plan.json`, JSON.stringify({ task: "no header" }));
    const blocked = await hook(["guard", "subagent-output"], {}, repo.root);
    expect(String(blocked.json?.reason)).toContain("plan.json: unknown or missing kind");
    await repo.write(
      `.metator/runs/${runId}/plan.json`,
      JSON.stringify({
        kind: "Plan",
        schemaVersion: 1,
        task: "t",
        scope: ["src/**"],
        steps: [{ id: "S1", action: "modify", path: "src/a.ts", intent: "x" }],
      }),
    );
    expect((await hook(["guard", "subagent-output"], {}, repo.root)).json).toBeNull();

    expect((await hook(["guard", "precompact"], {}, repo.root)).json).toBeNull();
    expect(await repo.read(`.metator/runs/${runId}/log.md`)).toContain("checkpoint · build (active)");

    const session = await hook(["guard", "session-start"], {}, repo.root);
    expect(contextOf(session)).toContain(`Active run ${runId} (feature): stage build`);
  });

  test("a broken state.json makes the guard speak up instead of deciding", async () => {
    const state = await repo.read(`.metator/runs/${runId}/state.json`);
    await repo.write(`.metator/runs/${runId}/state.json`, "{");
    try {
      const out = await hook(
        ["guard", "pre-tool"],
        { tool_name: "Edit", tool_input: { file_path: repo.path("src/a.ts") } },
        repo.root,
      );
      expect([out.code, String(out.json?.systemMessage)]).toEqual([
        0,
        expect.stringContaining("metator guard pre-tool:"),
      ]);
    } finally {
      await repo.write(`.metator/runs/${runId}/state.json`, state);
    }
  });

  test("run checkpoint is also a command with the envelope", async () => {
    const r = await metator(["run", "checkpoint"], repo.root);
    expect([r.code, (r.json.data as { runId: string }).runId]).toEqual([0, runId]);
  });
});

describe("metator generate --hooks writes both hosts' hook configuration", () => {
  test("Claude Code settings keep the user's keys; Copilot gets its own hooks file; --check is clean after", async () => {
    await repo.write(".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    await repo.write(
      "metator.config.yml",
      "kind: MetatorConfig\nschemaVersion: 1\nhosts:\n  metatorCommand: npx metator\n",
    );
    expect((await metator(["generate"], repo.root)).code).toBe(0);
    expect(await repo.exists(".github/hooks/metator.json")).toBe(false); // hooks are opt-in
    const r = await metator(["generate", "--hooks"], repo.root);
    expect(r.code).toBe(0);
    const claude = JSON.parse(await repo.read(".claude/settings.json")) as {
      permissions: unknown;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(claude.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(claude.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("npx metator guard pre-tool");
    const copilot = JSON.parse(await repo.read(".github/hooks/metator.json")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(copilot.hooks)).toEqual([
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "SubagentStop",
      "PreCompact",
      "Stop",
    ]);
    expect((await metator(["generate", "--check", "--hooks"], repo.root)).code).toBe(0);
  });
});
