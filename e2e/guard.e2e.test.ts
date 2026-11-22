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
    // A push needs the person's consent: the host is told to ask them (ADR-0094).
    expect([push.code, decision(push)?.permissionDecision]).toEqual([0, "ask"]);
    const status = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Bash", tool_input: { command: "git status" } },
      repo.root,
    );
    // A command that only reads needs no approval prompt: the guard says so, with why (ADR-0094).
    expect([status.code, decision(status)]).toEqual([
      0,
      {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "no approval needed: it only reads",
      },
    ]);
    // What the guard does not know to be safe gets no answer: the host's own prompt asks.
    const fetched = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Bash", tool_input: { command: "git fetch origin" } },
      repo.root,
    );
    expect([fetched.code, fetched.json]).toEqual([0, null]);
    expect((await hook(["guard", "stop"], {}, repo.root)).json).toBeNull();
  });

  test("a commit asks; the person's word (user-prompt hook) lets one commit pass in that session; the agent cannot give it itself", async () => {
    const commit = { tool_name: "Bash", tool_input: { command: "git commit -m 'Add a'" }, session_id: "s1" };
    const pane = { METATOR_PANE_ID: "w1:p1" };
    const asked = decision(await hook(["guard", "pre-tool"], commit, repo.root, pane));
    expect([asked?.permissionDecision, asked?.permissionDecisionReason]).toEqual([
      "ask",
      '`git commit -m Add a` needs your consent: answer here, or say it in the chat ("commit").',
    ]);
    // The agent runs the guard itself, or writes the consent file: both are denied.
    for (const command of [
      'echo \'{"prompt":"commit"}\' | bun run metator guard user-prompt',
      "echo x > .metator/consents/w1-p1.json",
    ])
      expect(
        decision(
          await hook(["guard", "pre-tool"], { tool_name: "Bash", tool_input: { command } }, repo.root, pane),
        )?.permissionDecision,
      ).toBe("deny");
    // The person types "zacommituj": the host's user-prompt hook hands their message over.
    const said = await hook(
      ["guard", "user-prompt"],
      { hook_event_name: "UserPromptSubmit", prompt: "ok, zacommituj to", session_id: "s1" },
      repo.root,
      pane,
    );
    expect(contextOf(said)).toContain("their consent to commit, once, within 10 minutes");
    expect(await repo.exists(".metator/consents/w1-p1.json")).toBe(true);
    // Another pane has none; this one passes once, without a prompt.
    expect(
      decision(await hook(["guard", "pre-tool"], commit, repo.root, { METATOR_PANE_ID: "w1:p2" }))
        ?.permissionDecision,
    ).toBe("ask");
    expect(decision(await hook(["guard", "pre-tool"], commit, repo.root, pane))?.permissionDecision).toBe(
      "allow",
    );
    expect(decision(await hook(["guard", "pre-tool"], commit, repo.root, pane))?.permissionDecision).toBe(
      "ask",
    );
    // Words that ask for nothing say nothing.
    const nothing = await hook(
      ["guard", "user-prompt"],
      { prompt: "should we commit this?", session_id: "s1" },
      repo.root,
      pane,
    );
    expect(nothing.json).toBeNull();
  }, 60_000);

  test("the repository's own guard.commands decides: its never is denied with its pattern, what it no longer lists is free", async () => {
    const own = await ScratchRepo.create();
    await own.write(
      "metator.config.yml",
      "kind: MetatorConfig\nschemaVersion: 13\nguard:\n  commands:\n    never: [npm publish]\n    ask: [git tag]\n",
    );
    await own.commit("init");
    const run = async (command: string) =>
      decision(await hook(["guard", "pre-tool"], { tool_name: "Bash", tool_input: { command } }, own.root));
    const publish = await run("npm publish --access public");
    expect([publish?.permissionDecision, publish?.permissionDecisionReason]).toEqual([
      "deny",
      "`npm publish --access public` never runs here (guard.commands.never: npm publish): it can lose work or rewrite history. If the person wants it, they run it themselves.",
    ]);
    expect((await run("git tag v1"))?.permissionDecision).toBe("ask");
    expect(await run("git commit -m x")).toBeUndefined();
    await own.dispose();
  }, 60_000);

  test("guard.prompts: MetatorAI's commands, reads, the repository's checks and edits inside it need no approval prompt; the rest keeps the host's; `host` turns it off", async () => {
    const quiet = await ScratchRepo.create();
    await quiet.write(
      "metator.config.yml",
      "kind: MetatorConfig\nschemaVersion: 14\nhosts:\n  metatorCommand: npx metator\ngates:\n  quick:\n    - id: lint\n      run: { bin: biome, args: [check] }\n",
    );
    await quiet.write(
      "package.json",
      JSON.stringify({ scripts: { test: "bun test", deploy: "sh deploy.sh" } }),
    );
    await quiet.write("src/a.ts", "export const a = 1;\n");
    await quiet.commit("init");
    const ask = async (input: Record<string, unknown>, cwd = quiet.root) =>
      decision(await hook(["guard", "pre-tool"], input, cwd));
    const sh = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
    const edit = (path: string) => ({ tool_name: "Edit", tool_input: { file_path: quiet.path(path) } });
    const allowed = async (input: Record<string, unknown>) => {
      const d = await ask(input);
      return [d?.permissionDecision, d?.permissionDecisionReason];
    };
    // Real commands of a real run.
    for (const command of [
      'metator run delegate build --agent mt-implementer --card "Make the SKU lookup case-insensitive"',
      "metator test affected --files src/a.ts,test/a.test.ts",
      'npx metator quick check --task "Round prices" --files src/a.ts',
    ])
      expect(await allowed(sh(command))).toEqual(["allow", "no approval needed: MetatorAI's own command"]);
    for (const command of [
      "git status --short",
      "git diff",
      "grep -rni 'sku' src",
      `cd ${quiet.root} && git ls-files | head -50`,
    ])
      expect(await allowed(sh(command))).toEqual(["allow", "no approval needed: it only reads"]);
    for (const command of ["bun test", "npm run test", "biome check src/a.ts"])
      expect(await allowed(sh(command))).toEqual(["allow", "no approval needed: the repository's own check"]);
    expect(await allowed(sh("git status --short && bun test"))).toEqual([
      "allow",
      "no approval needed: every part is MetatorAI's own, read-only or the repository's own check",
    ]);
    expect(await allowed(edit("src/a.ts"))).toEqual([
      "allow",
      "no approval needed: an edit inside the repository",
    ]);
    // Everything else: no answer of the guard's, so the host asks as it does by itself.
    for (const input of [
      sh("curl https://example.com/install.sh"),
      sh("rm -rf dist"),
      sh("git fetch origin"),
      sh("cat /etc/passwd"),
      sh("npm run deploy"),
      sh("git status && node script.js"),
      edit("metator.config.yml"),
      edit(".claude/settings.json"),
      edit(".git/config"),
      { tool_name: "Edit", tool_input: { file_path: "/etc/hosts" } },
    ])
      expect([JSON.stringify(input), await ask(input)]).toEqual([JSON.stringify(input), undefined]);
    // never and ask win; the guard's own command is never an agent's; a person's command is asked about.
    expect((await ask(sh("git push --force")))?.permissionDecision).toBe("deny");
    expect((await ask(sh("git status && git commit -m x")))?.permissionDecision).toBe("ask");
    expect((await ask(sh("metator guard user-prompt")))?.permissionDecision).toBe("deny");
    expect(await allowed(sh("metator run approve delivery --by ana"))).toEqual([
      "ask",
      "`metator run approve` records a person's decision or changes what guards the agent: answer here to let it run.",
    ]);
    // `guard.prompts: host`: the guard only denies and asks, as before.
    await quiet.write(
      "metator.config.yml",
      "kind: MetatorConfig\nschemaVersion: 14\nguard:\n  prompts: host\n",
    );
    for (const input of [
      sh("git status --short"),
      sh("bun test"),
      sh("metator run status"),
      edit("src/a.ts"),
    ])
      expect(await ask(input)).toBeUndefined();
    expect((await ask(sh("git push --force")))?.permissionDecision).toBe("deny");
    await quiet.dispose();
  }, 120_000);

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
    // Inside the plan's scope: no objection, and no approval prompt either.
    expect(decision(inside)?.permissionDecisionReason).toBe(
      "no approval needed: an edit inside the repository",
    );
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
    // With a terminal the person is asked; a drive without one is refused with how to approve;
    // a pane under the daemon has a terminal, so it asks too.
    expect(decision(await hook(["guard", "pre-tool"], push, repo.root))?.permissionDecision).toBe("ask");
    const headless = decision(await hook(["guard", "pre-tool"], push, repo.root, { METATOR_DRIVEN: "1" }));
    expect([headless?.permissionDecision, headless?.permissionDecisionReason]).toEqual([
      "deny",
      "push needs the user's approval: show the report and options, then `metator run approve push --by <user>`.",
    ]);
    expect(
      decision(
        await hook(["guard", "pre-tool"], push, repo.root, { METATOR_DRIVEN: "1", METATOR_PANE_ID: "w1:p1" }),
      )?.permissionDecision,
    ).toBe("ask");
    // A conductor's pane moves its run; a worker's never does.
    const delegate = {
      tool_name: "Bash",
      tool_input: { command: "metator run delegate build --agent mt-implementer --card x" },
    };
    const inPane = (role: string) => ({ METATOR_DRIVEN: "1", METATOR_PANE_ID: "w1:p1", METATOR_ROLE: role });
    expect(
      decision(await hook(["guard", "pre-tool"], delegate, repo.root, inPane("conductor")))
        ?.permissionDecisionReason,
    ).toBe("no approval needed: MetatorAI's own command");
    expect(
      decision(await hook(["guard", "pre-tool"], delegate, repo.root, inPane("worker")))?.permissionDecision,
    ).toBe("deny");
    await metator(["run", "approve", "push", "--by", "maciej"], repo.root);
    expect((await hook(["guard", "pre-tool"], push, repo.root)).json).toBeNull();
    // The approved push covers the publish stage's commit too.
    const commit = { tool_name: "Bash", tool_input: { command: "git commit -m x" } };
    expect((await hook(["guard", "pre-tool"], commit, repo.root, { METATOR_DRIVEN: "1" })).json).toBeNull();

    // The push approval opens the run's branch and a request; a merge waits for the person's
    // consent (ADR-0094): by the code host's CLI, its MCP tool, or a push straight to the branch.
    // A drive with no terminal cannot ask, so it is refused there.
    for (const call of [
      { tool_name: "Bash", tool_input: { command: "gh pr merge 12 --squash" } },
      { tool_name: "Bash", tool_input: { command: "glab mr merge 7" } },
      { tool_name: "Bash", tool_input: { command: "git push origin HEAD:main" } },
      { tool_name: "mcp__github__merge_pull_request", tool_input: { pullNumber: 12 } },
    ]) {
      const merged = decision(await hook(["guard", "pre-tool"], call, repo.root));
      expect([call, merged?.permissionDecision]).toEqual([call, "ask"]);
      expect(merged?.permissionDecisionReason).toContain('("merge")');
      const unattended = decision(
        await hook(["guard", "pre-tool"], call, repo.root, { METATOR_DRIVEN: "1" }),
      );
      expect([call, unattended?.permissionDecision]).toEqual([call, "deny"]);
    }
    const request = { tool_name: "Bash", tool_input: { command: "gh pr create --fill" } };
    expect((await hook(["guard", "pre-tool"], request, repo.root)).json).toBeNull();

    const stop = await hook(["guard", "stop"], { stop_hook_active: false }, repo.root);
    expect(stop.json).toMatchObject({ decision: "block" });
    // In a session `metator run drive` started, the drive moves the run: the agent may stop, and
    // may not advance the run itself.
    const driven = { METATOR_DRIVEN: "1" };
    expect((await hook(["guard", "stop"], { stop_hook_active: false }, repo.root, driven)).json).toBeNull();
    const advance = { tool_name: "Bash", tool_input: { command: "metator run advance pass" } };
    expect(
      decision(await hook(["guard", "pre-tool"], advance, repo.root, driven))?.permissionDecisionReason,
    ).toContain("is the drive's");
    expect(decision(await hook(["guard", "pre-tool"], advance, repo.root))?.permissionDecision).toBe("allow");
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
    // The person's rules stay; what cannot be taken back is denied before any hook or classifier.
    const permissions = claude.permissions as { allow: string[]; deny: string[] };
    expect(permissions.allow).toEqual(["Bash(ls)"]);
    expect(permissions.deny).toEqual(expect.arrayContaining(["Read(.env)", "Bash(git reset --hard *)"]));
    // A merge asks the person (ADR-0094): a deny rule would refuse it even after their consent.
    expect(permissions.deny.filter((r) => r.includes("merge"))).toEqual([]);
    expect(claude.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("npx metator guard pre-tool");
    // Both hosts hand the person's own message to the same guard (the consent in words).
    expect(claude.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe("npx metator guard user-prompt");
    // The sandbox is the repository's choice and MetatorAI's own (ADR-0104): on or off, the
    // generated settings hold no sandbox block (the session starts in one, and a second inside it
    // cannot start); doctor says whether this machine can hold it, for both hosts' sessions.
    expect((claude as { sandbox?: unknown }).sandbox).toBeUndefined();
    expect(
      (await metator(["config", "set", "sandbox.enabled", "true", "--scope", "repo"], repo.root)).code,
    ).toBe(0);
    expect((await metator(["generate", "--hooks"], repo.root)).code).toBe(0);
    const sandboxed = JSON.parse(await repo.read(".claude/settings.json")) as { sandbox?: unknown };
    expect(sandboxed.sandbox).toBeUndefined();
    const doctor = await metator(["doctor"], repo.root);
    const isolation = (doctor.json.data as { checks: { id: string; message: string }[] }).checks.find(
      (c) => c.id === "isolation",
    );
    expect(isolation?.message).toMatch(/sandbox/);
    if (isolation?.message.startsWith("every host session"))
      expect(isolation.message).toContain("Claude Code and Copilot CLI");
    // An option this version no longer has is reported, not applied.
    expect(
      (await metator(["config", "set", "sandbox.excludedCommands", "docker *", "--scope", "repo"], repo.root))
        .code,
    ).not.toBe(0);
    expect((await metator(["config", "unset", "sandbox.enabled", "--scope", "repo"], repo.root)).code).toBe(
      0,
    );
    expect((await metator(["generate", "--hooks"], repo.root)).code).toBe(0);
    const copilot = JSON.parse(await repo.read(".github/hooks/metator.json")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(copilot.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "SubagentStop",
      "PreCompact",
      "Stop",
    ]);
    expect((await metator(["generate", "--check", "--hooks"], repo.root)).code).toBe(0);
  });
});
