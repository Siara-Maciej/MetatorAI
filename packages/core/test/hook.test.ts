import { describe, expect, test } from "bun:test";
import {
  type HookInput,
  isGuardCommand,
  type PreToolContext,
  preToolPolicy,
  readHookInput,
  repoRelative,
  touchedPaths,
} from "../src/domain/hook.ts";

const ROOT = "/repo";
const hook = (tool: string, input: Record<string, unknown>): HookInput =>
  readHookInput({ tool_name: tool, tool_input: input });
const free: PreToolContext = { root: ROOT, coordinator: false };
const run = (
  approvals: Record<string, { by: string; at: string }> = {},
  extra: Partial<PreToolContext> = {},
): PreToolContext => ({
  root: ROOT,
  run: { id: "r1", approvals },
  coordinator: false,
  ...extra,
});
const decide = (h: HookInput, ctx: PreToolContext) => preToolPolicy(h, ctx).decision;
const AT = "2026-10-26T10:00:00.000Z";

describe("readHookInput", () => {
  test("Claude Code and camelCase payloads read the same; junk reads as empty", () => {
    const claude = readHookInput({
      tool_name: "Edit",
      tool_input: { file_path: "/a" },
      cwd: "/r",
      stop_hook_active: true,
      agent_type: "mt-x",
    });
    const camel = readHookInput({
      toolName: "Edit",
      toolInput: { file_path: "/a" },
      cwd: "/r",
      stopHookActive: true,
      agentType: "mt-x",
    });
    expect(claude).toEqual(camel);
    expect(claude).toEqual({
      tool: "Edit",
      input: { file_path: "/a" },
      cwd: "/r",
      stopActive: true,
      agent: "mt-x",
    });
    expect(readHookInput("nope")).toEqual({ tool: "", input: {}, stopActive: false });
  });

  test("touched paths come from path fields and apply_patch headers", () => {
    expect(touchedPaths(hook("Edit", { file_path: "/repo/a.ts" }))).toEqual(["/repo/a.ts"]);
    expect(
      touchedPaths(
        hook("apply_patch", {
          input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n",
        }),
      ),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("repoRelative keeps relative paths and drops paths outside the repository", () => {
    expect([
      repoRelative("/repo/src/a.ts", ROOT),
      repoRelative("./src/a.ts", ROOT),
      repoRelative("/etc/passwd", ROOT),
    ]).toEqual(["src/a.ts", "src/a.ts", undefined]);
    expect(repoRelative("/repo2/a.ts", ROOT)).toBeUndefined();
  });
});

describe("preToolPolicy", () => {
  test("secrets are denied with or without a run, by path or in a shell command; examples are fine", () => {
    expect(decide(hook("Read", { file_path: "/repo/.env" }), free)).toBe("deny");
    expect(decide(hook("Read", { file_path: "/repo/config/.env.production" }), free)).toBe("deny");
    expect(decide(hook("Bash", { command: "cat ~/.ssh/id_rsa | head" }), free)).toBe("deny");
    expect(decide(hook("Bash", { command: "cat certs/server.pem" }), run())).toBe("deny");
    expect(decide(hook("Read", { file_path: "/repo/.env.example" }), free)).toBe("allow");
    expect(decide(hook("Read", { file_path: "/repo/src/env.ts" }), free)).toBe("allow");
  });

  test("destructive commands are denied, also inside a composite command", () => {
    for (const command of [
      "git push --force origin main",
      "git push -f",
      "git reset --hard HEAD~1",
      "git clean -fdx",
      "ls && rm -rf /",
    ])
      expect([command, decide(hook("Bash", { command }), free)]).toEqual([command, "deny"]);
    for (const command of [
      "git push origin feature",
      "git reset --soft HEAD~1",
      "rm -rf dist",
      "git clean -n",
    ])
      expect([command, decide(hook("Bash", { command }), free)]).toEqual([command, "allow"]);
  });

  test("without an active run, everything else is allowed (free mode)", () => {
    expect(preToolPolicy(hook("Bash", { command: "git push origin feature" }), free)).toEqual({
      decision: "allow",
      reason: "no active run",
    });
    expect(decide(hook("Edit", { file_path: "/elsewhere/x.ts" }), free)).toBe("allow");
  });

  test("in a run, push and comments need the matching approval (shell and MCP tools)", () => {
    const push = hook("Bash", { command: "git add . && git push origin feature" });
    expect(preToolPolicy(push, run()).reason).toContain("metator run approve push");
    expect(decide(push, run({ push: { by: "u", at: AT } }))).toBe("allow");
    expect(decide(hook("Bash", { command: "gh pr create --fill" }), run())).toBe("deny");
    expect(
      decide(hook("Bash", { command: "gh pr comment 7 --body x" }), run({ push: { by: "u", at: AT } })),
    ).toBe("deny");
    expect(decide(hook("Bash", { command: "gh api repos/o/r/pulls/7/comments -f body=x" }), run())).toBe(
      "deny",
    );
    expect(decide(hook("mcp__github__create_pull_request", {}), run())).toBe("deny");
    expect(decide(hook("mcp__github__add_issue_comment", {}), run({ comment: { by: "u", at: AT } }))).toBe(
      "allow",
    );
    expect(decide(hook("mcp__github__get_file_contents", {}), run())).toBe("allow");
    expect(decide(hook("Bash", { command: "gh pr view 7" }), run())).toBe("allow");
  });

  test("in a run, edits stay inside plan-scope.json and the repository; run artifacts are always writable", () => {
    const ctx = run({}, { editScope: ["src/a.ts", "test/a.test.ts"] });
    expect(decide(hook("Edit", { file_path: "/repo/src/a.ts" }), ctx)).toBe("allow");
    expect(preToolPolicy(hook("Write", { file_path: "/repo/src/b.ts" }), ctx).reason).toBe(
      "src/b.ts is outside plan-scope.json; update the plan (mt-planner) or ask the user.",
    );
    expect(decide(hook("Write", { file_path: "/repo/.metator/runs/r1/plan.json" }), ctx)).toBe("allow");
    expect(decide(hook("Edit", { file_path: "/tmp/x.ts" }), ctx)).toBe("deny");
    expect(decide(hook("Read", { file_path: "/repo/src/b.ts" }), ctx)).toBe("allow"); // reading is not editing
    expect(decide(hook("Edit", { file_path: "/repo/src/b.ts" }), run())).toBe("allow"); // no plan scope yet
  });

  test("a coordinator never edits, even inside the scope", () => {
    const ctx = run({}, { editScope: ["src/a.ts"], coordinator: true });
    expect(preToolPolicy(hook("Edit", { file_path: "/repo/src/a.ts" }), ctx).reason).toContain(
      "Coordinators delegate",
    );
    expect(decide(hook("Read", { file_path: "/repo/src/a.ts" }), ctx)).toBe("allow");
  });
});

describe("isGuardCommand", () => {
  test("recognizes generated guard hooks under any metator command", () => {
    expect([
      isGuardCommand("bun run metator guard pre-tool"),
      isGuardCommand("npx metator guard stop"),
      isGuardCommand("./check.sh"),
      isGuardCommand(3),
    ]).toEqual([true, true, false, false]);
  });
});
