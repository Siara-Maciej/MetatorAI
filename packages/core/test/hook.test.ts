import { describe, expect, test } from "bun:test";
import {
  CHAT_APPROVAL_NEEDS_DRIVER,
  chatApproval,
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

  test("an agent never approves a refactor or system plan; run approvals keep their relay", () => {
    for (const command of [
      "bun run metator arch plan approve split-kit --by maciej",
      "bun run metator system plan approve rename-refunds",
      "metator -C ../platform system plan approve x --by ana",
      "metator -C ../shop arch plan approve split-kit",
      "cd x && bun packages/cli/src/main.ts arch plan approve p",
    ])
      expect([command, decide(hook("Bash", { command }), free)]).toEqual([command, "deny"]);
    for (const command of [
      "bun run metator arch plan lint split-kit",
      "bun run metator system plan lint rename-refunds",
      "bun run metator run approve push --by maciej",
      "echo approve",
    ])
      expect([command, decide(hook("Bash", { command }), free)]).toEqual([command, "allow"]);
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
    for (const command of ["git reset --soft HEAD~1", "rm -rf dist", "git clean -n", "git add -A"])
      expect([command, decide(hook("Bash", { command }), free)]).toEqual([command, "allow"]);
    // The reason names the command and where the rule is.
    expect(preToolPolicy(hook("Bash", { command: "git reset --hard" }), free).reason).toBe(
      "`git reset --hard` never runs here (guard.commands.never: git reset --hard): it can lose work or rewrite history. If the person wants it, they run it themselves.",
    );
  });

  test("without an active run, everything else is allowed (free mode)", () => {
    expect(preToolPolicy(hook("Bash", { command: "git status" }), free)).toEqual({
      decision: "allow",
      reason: "no active run",
    });
    expect(decide(hook("Edit", { file_path: "/elsewhere/x.ts" }), free)).toBe("allow");
  });

  test("commit, push, merge and rebase need the person's consent: the host asks, with or without a run (ADR-0094)", () => {
    for (const command of ["git commit -m x", "git push origin feature", "git merge main", "git rebase main"])
      expect([command, decide(hook("Bash", { command }), free)]).toEqual([command, "ask"]);
    const commit = preToolPolicy(
      hook("Bash", { command: "git add -A && git commit -m 'Add the badge'" }),
      free,
    );
    expect(commit).toEqual({
      decision: "ask",
      reason:
        '`git commit -m Add the badge` needs your consent: answer here, or say it in the chat ("commit").',
    });
    // The repository's own list decides: nothing asked, nothing denied.
    const none = { ...free, commands: { never: [], ask: [], allow: [] } };
    expect(decide(hook("Bash", { command: "git commit -m x" }), none)).toBe("allow");
    expect(decide(hook("Bash", { command: "git reset --hard" }), none)).toBe("allow");
  });

  test("a consent the person gave in words lets one command of its kind pass, and says which consent was used", () => {
    const said = { ...free, consents: ["commit"] };
    expect(preToolPolicy(hook("Bash", { command: "git commit -m x" }), said)).toEqual({
      decision: "allow",
      reason: "the person consented to commit in the chat",
      consents: ["commit"],
    });
    // A consent to commit is none to push; both in one line need both.
    expect(decide(hook("Bash", { command: "git push" }), said)).toBe("ask");
    expect(decide(hook("Bash", { command: "git commit -m x && git push" }), said)).toBe("ask");
    const both = preToolPolicy(hook("Bash", { command: "git commit -m x && git push" }), {
      ...free,
      consents: ["commit", "push"],
    });
    expect([both.decision, both.consents]).toEqual(["allow", ["commit", "push"]]);
    // A consent never lifts a never.
    expect(decide(hook("Bash", { command: "git push --force" }), { ...free, consents: ["push"] })).toBe(
      "deny",
    );
  });

  test('a commit that holds debug changes is stopped with the files, whatever was consented; "commit anyway" lets it pass', () => {
    const debug = { ...free, consents: ["commit"], debugFiles: ["src/a.ts", "src/b.ts"] };
    expect(preToolPolicy(hook("Bash", { command: "git commit -m x" }), debug)).toEqual({
      decision: "ask",
      reason:
        "this commit holds debug changes: src/a.ts, src/b.ts. Remove them first (`metator scratch drop`), or answer here to commit anyway.",
    });
    const anyway = preToolPolicy(hook("Bash", { command: "git commit -m x" }), {
      ...debug,
      consents: ["commit", "commit-debug"],
    });
    expect([anyway.decision, anyway.consents]).toEqual(["allow", ["commit-debug", "commit"]]);
  });

  test("an agent never runs a guard itself and never writes a consent: only the person's words do", () => {
    for (const command of [
      'echo \'{"prompt":"commit"}\' | metator guard user-prompt',
      "bun run metator guard user-prompt",
      "echo x > .metator/consents/w1-p1.json",
    ])
      expect([command, decide(hook("Bash", { command }), free)]).toEqual([command, "deny"]);
    expect(decide(hook("Write", { file_path: "/repo/.metator/consents/w1-p1.json" }), free)).toBe("deny");
    expect(decide(hook("Write", { file_path: "/repo/.metator/runs/r1/notes.md" }), free)).toBe("allow");
  });

  test("in a run, push and comments need the matching approval (shell and MCP tools)", () => {
    const push = hook("Bash", { command: "git add . && git push origin feature" });
    // With a terminal the person is asked (the approval is named too); a drive without one is refused.
    expect(preToolPolicy(push, run())).toEqual({
      decision: "ask",
      reason:
        '`git push origin feature` needs your consent: answer here, say it in the chat ("push"), or `metator run approve push --by <user>`.',
    });
    expect(preToolPolicy(push, run({}, { headless: true }))).toEqual({
      decision: "deny",
      reason:
        "push needs the user's approval: show the report and options, then `metator run approve push --by <user>`.",
    });
    expect(decide(push, run({ push: { by: "u", at: AT } }))).toBe("allow");
    // The delivery's approval (it grants the push) covers the publish stage's commit as well.
    const commit = hook("Bash", { command: "git commit -m 'Add the badge'" });
    expect(decide(commit, run({}, { headless: true }))).toBe("deny");
    expect(preToolPolicy(commit, run({ push: { by: "u", at: AT } }))).toEqual({
      decision: "allow",
      reason: "ok",
    });
    expect(decide(commit, run({ commit: { by: "u", at: AT } }))).toBe("allow");
    expect(decide(hook("Bash", { command: "git push" }), run({ commit: { by: "u", at: AT } }))).toBe("ask");
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

describe("a worker pane (R2, ADR-0080)", () => {
  test("never steers the run: delegate, collect, start, advance are denied; its report and reading are fine", () => {
    const worker = run({}, { worker: true });
    for (const command of [
      "metator run delegate build --agent mt-implementer --card x",
      "metator run collect mt-planner-1",
      "metator run start",
      "metator run advance pass",
      "bun run metator run approve plan-approval --by m",
      // Starting a run is steering too, under its new name and its old one.
      'metator run new --workflow mt-feature --task "x y z w"',
      'metator run init --workflow mt-feature --task "x y z w"',
    ]) {
      const d = preToolPolicy(hook("Bash", { command }), worker);
      expect([command, d.decision]).toEqual([command, "deny"]);
      expect(d.reason).toContain("is the conductor's");
      expect(d.reason).toContain("metator run result");
    }
    expect(
      decide(
        hook("Bash", { command: 'metator run result --worker mt-planner-1 --status done --summary "ok"' }),
        worker,
      ),
    ).toBe("allow");
    expect(decide(hook("Bash", { command: "metator run status" }), worker)).toBe("allow");
    expect(decide(hook("Read", { file_path: "src/a.ts" }), worker)).toBe("allow");
    // Not a worker: the same command is the conductor's to run.
    expect(
      decide(hook("Bash", { command: "metator run delegate build --agent mt-implementer --card x" }), run()),
    ).toBe("allow");
  });
});

describe("an approval from the chat (ADR-0077)", () => {
  const chat = hook("Bash", { command: "metator run approve plan-approval --by maciej --via chat" });
  test("is the one run-control command an agent may run, and only while a person is attached", () => {
    expect(chatApproval(chat)).toBe(true);
    expect(chatApproval(hook("Bash", { command: "metator run approve plan-approval --by maciej" }))).toBe(
      false,
    );
    expect(chatApproval(hook("Bash", { command: "metator run advance pass --via chat" }))).toBe(false);
    expect(
      chatApproval(hook("Bash", { command: "metator run approve x --by m --via chat && echo ok" })),
    ).toBe(false);
    expect(chatApproval(hook("Read", { file_path: "a" }))).toBe(false);
    const driven = (driver: "agent" | "human") => ({
      ...run({}, { driven: true }),
      run: { id: "r1", approvals: {}, driver },
    });
    const nobody = preToolPolicy(chat, driven("agent"));
    expect([nobody.decision, nobody.reason]).toEqual(["deny", CHAT_APPROVAL_NEEDS_DRIVER]);
    expect(preToolPolicy(chat, driven("human")).decision).toBe("allow");
    // Any other run control stays the drive's, attached or not.
    const advance = hook("Bash", { command: "metator run advance pass" });
    expect(preToolPolicy(advance, driven("human")).decision).toBe("deny");
    expect(preToolPolicy(advance, driven("human")).reason).toContain("is the drive's");
  });
});
