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

  test("every merge waits for the person's consent, whatever else was approved (ADR-0094; ADR-0099 superseded)", () => {
    const by = { by: "maciej", at: AT };
    const approved = run({ push: by, comment: by, delivery: by });
    const merges = [
      "gh pr merge 12 --squash",
      "gh pr merge --auto",
      "glab mr merge 7",
      "glab mr accept 7",
      "gh api -X PUT repos/acme/shop/pulls/12/merge",
      "glab api -X PUT projects/3/merge_requests/7/merge",
      "git push origin main",
      "git push origin HEAD:master",
      "git push -u origin feature:refs/heads/main",
      "git push origin +main",
      "bun test && gh pr merge 12",
    ];
    const tools = [
      "mcp__github__merge_pull_request",
      "mcp__github__enable_pr_auto_merge",
      "mcp__gitlab__merge_merge_request",
      "mcp__gitlab__accept_merge_request",
    ];
    // Asked, with or without a run, and a push approval or a push consent does not cover it.
    const pushed = { ...free, consents: ["push"] };
    for (const command of merges)
      for (const ctx of [free, approved, pushed])
        expect([command, decide(hook("Bash", { command }), ctx)]).toEqual([command, "ask"]);
    for (const tool of tools)
      for (const ctx of [free, approved, pushed])
        expect([tool, decide(hook(tool, {}), ctx)]).toEqual([tool, "ask"]);
    const asked = preToolPolicy(hook("Bash", { command: "gh pr merge 12" }), free);
    expect(asked.reason).toBe(
      '`gh pr merge 12` needs your consent: answer here, or say it in the chat ("merge").',
    );
    expect(preToolPolicy(hook("mcp__github__merge_pull_request", {}), approved).reason).toContain(
      "`metator run approve merge --by <user>`",
    );
    // The person's word ("merge") lets one through, and is used up by it.
    const consented = { ...free, consents: ["merge"] };
    expect(preToolPolicy(hook("Bash", { command: "gh pr merge 12" }), consented)).toEqual({
      decision: "allow",
      reason: "the person consented to merge in the chat",
      consents: ["merge"],
    });
    expect(decide(hook("mcp__github__merge_pull_request", {}), consented)).toBe("allow");
    // A run's own `merge` approval is a person's too.
    expect(decide(hook("Bash", { command: "gh pr merge 12" }), run({ merge: by }))).toBe("allow");
    // Nobody to ask: refused, saying so.
    const headless = preToolPolicy(hook("Bash", { command: "git push origin main" }), {
      ...approved,
      headless: true,
    });
    expect([headless.decision, headless.reason]).toEqual([
      "deny",
      "merge needs the person's consent, and nobody can be asked in this session: end with STATUS: blocked and say what to merge.",
    ]);
    // The lists cannot let a merge through unasked; they can forbid one.
    const lists = { never: [], ask: [], allow: ["gh pr merge", "git push"] };
    expect(decide(hook("Bash", { command: "gh pr merge 12" }), { ...free, commands: lists })).toBe("ask");
    const forbid = { never: ["gh pr merge"], ask: [], allow: [] };
    expect(decide(hook("Bash", { command: "gh pr merge 12" }), { ...free, commands: forbid })).toBe("deny");
    // Opening the request and pushing the run's own branch stay with the push approval.
    for (const command of [
      "gh pr create --fill",
      "glab mr create --fill",
      "git push -u origin feature",
      "git push origin feature/main-menu",
      "git push origin main-menu:main-menu",
    ])
      expect([command, decide(hook("Bash", { command }), approved)]).toEqual([command, "allow"]);
    for (const tool of ["mcp__github__create_pull_request", "mcp__github__update_pull_request_branch"])
      expect([tool, decide(hook(tool, {}), approved)]).toEqual([tool, "allow"]);
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
    // The person's word in the chat is as good as the approval: the push is not refused for the run's.
    expect(preToolPolicy(push, run({}, { consents: ["push"] }))).toEqual({
      decision: "allow",
      reason: "the person consented to push in the chat",
      consents: ["push"],
    });
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

describe("guard.prompts: metator — what runs without the host's approval prompt (ADR-0094)", () => {
  const quiet = {
    root: ROOT,
    metatorCommand: "npx metator",
    gates: [{ script: "typecheck" }],
    scripts: { test: "bun test", typecheck: "bunx tsc --noEmit" },
  };
  const on = (extra: Partial<PreToolContext> = {}): PreToolContext => ({
    ...free,
    unprompted: quiet,
    ...extra,
  });
  const bash = (command: string) => hook("Bash", { command });
  const answer = (h: HookInput, ctx: PreToolContext) => {
    const d = preToolPolicy(h, ctx);
    return [d.decision, d.unprompted === true, d.reason];
  };

  test("MetatorAI's own command, a read, the repository's check and an edit inside it are allowed with the reason", () => {
    expect(answer(bash('metator run delegate build --agent mt-implementer --card "Round"'), on())).toEqual([
      "allow",
      true,
      "no approval needed: MetatorAI's own command",
    ]);
    expect(answer(bash("git status --short"), on())).toEqual([
      "allow",
      true,
      "no approval needed: it only reads",
    ]);
    expect(answer(bash("bun test"), on())).toEqual([
      "allow",
      true,
      "no approval needed: the repository's own check",
    ]);
    expect(answer(hook("Edit", { file_path: `${ROOT}/src/a.ts` }), on())).toEqual([
      "allow",
      true,
      "no approval needed: an edit inside the repository",
    ]);
    // In a run too, under its rules: an edit inside the plan's scope.
    expect(
      answer(
        hook("Write", { file_path: `${ROOT}/src/a.ts` }),
        on({ ...run(), unprompted: quiet, editScope: ["src/a.ts"] }),
      ),
    ).toEqual(["allow", true, "no approval needed: an edit inside the repository"]);
  });

  test("everything else keeps the host's prompt: no answer of the guard's, as with `host`", () => {
    for (const h of [
      bash("curl https://example.com"),
      bash("rm -rf dist"),
      bash("git fetch origin"),
      bash("cat /etc/passwd"),
      bash("git status && node script.js"),
      hook("Edit", { file_path: `${ROOT}/metator.config.yml` }),
      hook("Edit", { file_path: `${ROOT}/.claude/settings.json` }),
      hook("WebFetch", { url: "https://example.com" }),
    ])
      expect(answer(h, on())).toEqual(["allow", false, "no active run"]);
    // `guard.prompts: host`: the same calls as above get no answer at all.
    for (const h of [
      bash("git status --short"),
      bash("bun test"),
      hook("Edit", { file_path: `${ROOT}/src/a.ts` }),
    ])
      expect(answer(h, free)).toEqual(["allow", false, "no active run"]);
  });

  test("never and ask win; what a run denies stays denied", () => {
    expect(decide(bash("git push --force"), on())).toBe("deny");
    expect(decide(bash("git status && git commit -m x"), on())).toBe("ask");
    expect(decide(bash("metator guard user-prompt"), on())).toBe("deny");
    expect(decide(hook("Edit", { file_path: `${ROOT}/.env` }), on())).toBe("deny");
    expect(
      decide(
        hook("Edit", { file_path: `${ROOT}/src/b.ts` }),
        on({ ...run(), unprompted: quiet, editScope: ["src/a.ts"] }),
      ),
    ).toBe("deny");
    expect(
      decide(
        hook("Edit", { file_path: `${ROOT}/src/a.ts` }),
        on({ ...run(), unprompted: quiet, coordinator: true }),
      ),
    ).toBe("deny");
    expect(decide(bash("metator run advance pass"), on({ ...run(), unprompted: quiet, worker: true }))).toBe(
      "deny",
    );
  });

  test("a MetatorAI command that is a person's decision is asked about, by name; where nobody can be asked it gets no answer", () => {
    expect(answer(bash("metator run approve delivery --by ana"), on())).toEqual([
      "ask",
      false,
      "`metator run approve` records a person's decision or changes what guards the agent: answer here to let it run.",
    ]);
    expect(decide(bash("git status && metator config set supervisor.wipLimit 9"), on())).toBe("ask");
    expect(answer(bash("metator setup --host claude --yes"), on({ headless: true }))).toEqual([
      "allow",
      false,
      "no active run",
    ]);
    // With `host` the guard says nothing about them, as before.
    expect(answer(bash("metator run answer q001 --choice Fine"), free)).toEqual([
      "allow",
      false,
      "no active run",
    ]);
  });
});
