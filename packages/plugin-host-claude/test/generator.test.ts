import { describe, expect, test } from "bun:test";
import { AgentDocument } from "@metator/core";
import { FakeTerminal, hostGeneratorContract, skillGeneratorContract } from "@metator/testing";
import { ClaudeGenerator } from "../src/claude-generator.ts";
import { claudeHost } from "../src/claude-host.ts";
import { ClaudeSkillGenerator } from "../src/skill-generator.ts";

const agent = (extra: Record<string, unknown>) =>
  AgentDocument.parse(
    {
      kind: "Agent",
      schemaVersion: 1,
      id: "mt-x",
      role: "worker",
      description: "Does one job, used by the coordinator only.",
      tier: "reasoning",
      capabilities: ["read", "search", "metator:graph"],
      ...extra,
    },
    "mt-x.md",
  )._unsafeUnwrap();

const BODY = "\n# Input\nRun `metator graph deps a.ts`.\n";

hostGeneratorContract("ClaudeGenerator", () => new ClaudeGenerator());
skillGeneratorContract("ClaudeSkillGenerator", () => new ClaudeSkillGenerator());

describe("ClaudeGenerator", () => {
  test("snapshot of the generated worker (tool table, model, marker)", () => {
    const file = new ClaudeGenerator().agent(agent({}), BODY, {
      source: "metator/agents/mt-x.md",
      metatorCommand: "bun run metator",
    });
    expect(file).toMatchSnapshot();
  });

  test("snapshot of a coordinator with every capability and a configured model", () => {
    const coordinator = agent({
      role: "coordinator",
      capabilities: ["read", "search", "edit", "execute", "agent", "todo", "web", "metator:run"],
      delegates: ["mt-a", "mt-b"],
    });
    const file = new ClaudeGenerator().agent(coordinator, BODY, {
      source: "metator/agents/mt-x.md",
      metatorCommand: "metator",
      model: "model-x",
    });
    expect(file).toMatchSnapshot();
  });

  test("a coordinator starts only its delegates; an agent capability without delegates stays open", () => {
    const tools = (delegates: string[]) =>
      new ClaudeGenerator()
        .agent(agent({ role: "coordinator", capabilities: ["read", "agent"], delegates }), BODY, {
          source: "metator/agents/mt-x.md",
          metatorCommand: "metator",
        })
        .content.match(/^tools: (.*)$/m)?.[1];
    expect(tools(["mt-a", "mt-b"])).toBe("Read, Glob, Agent(mt-a, mt-b)");
    expect(tools([])).toBe("Read, Glob, Task");
  });

  test("an agent with the whole shell still names its metator commands: they run without asking", () => {
    const file = new ClaudeGenerator().agent(
      agent({ capabilities: ["read", "execute", "metator:findings"] }),
      BODY,
      { source: "metator/agents/mt-x.md", metatorCommand: "metator" },
    );
    expect(file.content.match(/^tools: (.*)$/m)?.[1]).toBe(
      "Read, Glob, Bash, Bash(metator findings:*), Bash(metator run status:*), Bash(metator run schema:*), Bash(metator run write:*)",
    );
  });
});

describe("ClaudeGenerator.hooks (.claude/settings.json)", () => {
  type Settings = {
    model?: string;
    hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>;
  };
  const parse = (r: ReturnType<ClaudeGenerator["hooks"]>) =>
    JSON.parse(r._unsafeUnwrap().content) as Settings;

  test("every guard is bound to its event; post-edit only runs after edit tools", () => {
    const settings = parse(new ClaudeGenerator().hooks("bun run metator", undefined));
    expect(Object.keys(settings.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "SubagentStop",
      "PreCompact",
      "Stop",
    ]);
    expect(settings.hooks.PreToolUse).toEqual([
      { hooks: [{ type: "command", command: "bun run metator guard pre-tool", timeout: 5 }] } as never,
    ]);
    expect(settings.hooks.PostToolUse?.[0]?.matcher?.split("|")).toContain("Write");
  });

  test("what cannot be taken back is a deny rule too: secrets, merges and lost work (ADR-0100)", () => {
    type Denied = { permissions: { allow?: string[]; deny: string[] } };
    const deny = (existing?: string) =>
      (JSON.parse(new ClaudeGenerator().hooks("bun run metator", existing)._unsafeUnwrap().content) as Denied)
        .permissions;
    const rules = deny().deny;
    // Secrets by name at any depth, the examples carved out after the pattern they belong to.
    expect(rules).toEqual(
      expect.arrayContaining(["Read(.env)", "Read(.env.*)", "Read(*.pem)", "Read(id_rsa*)"]),
    );
    expect(rules.indexOf("Read(!.env.example)")).toBeGreaterThan(rules.indexOf("Read(.env.*)"));
    // A command with and without arguments; MCP tools of any server.
    expect(rules).toEqual(
      expect.arrayContaining([
        "Bash(gh pr merge)",
        "Bash(gh pr merge *)",
        "Bash(glab mr merge *)",
        "Bash(git push --force *)",
        "Bash(git reset --hard *)",
        "mcp__*__merge_pull_request",
        "mcp__*__enable_pr_auto_merge",
      ]),
    );
    expect(rules.some((r) => r.includes("pr create"))).toBe(false);
    // The person's own rules stay, ours are added once.
    const existing = JSON.stringify({
      permissions: { allow: ["Bash(ls)"], deny: ["Bash(curl *)", "Read(.env)"] },
    });
    const merged = deny(existing);
    expect(merged.allow).toEqual(["Bash(ls)"]);
    expect(merged.deny.slice(0, 2)).toEqual(["Bash(curl *)", "Read(.env)"]);
    expect(merged.deny.filter((r) => r === "Read(.env)")).toHaveLength(1);
    const again = deny(JSON.stringify({ permissions: merged }));
    expect(again.deny).toEqual(merged.deny);
  });

  test("a sandbox policy becomes the host's sandbox: on, no way out, the lists merged with the person's (ADR-0102)", () => {
    type Sandboxed = { sandbox?: Record<string, unknown> };
    const policy = {
      denyRead: ["~/.ssh", "~/.aws"],
      allowWrite: ["/tmp/build"],
      allowedDomains: ["registry.npmjs.org"],
      excludedCommands: ["docker compose *"],
    };
    const settings = (existing?: string, p: typeof policy | "none" = policy) =>
      JSON.parse(
        new ClaudeGenerator().hooks("bun run metator", existing, p === "none" ? undefined : p)._unsafeUnwrap()
          .content,
      ) as Sandboxed;
    expect(settings().sandbox).toEqual({
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: ["~/.ssh", "~/.aws"], allowWrite: ["/tmp/build"] },
      network: { allowedDomains: ["registry.npmjs.org"] },
      excludedCommands: ["docker compose *"],
    });
    // Without a policy nothing about the sandbox is written or taken away.
    expect(settings(undefined, "none").sandbox).toBeUndefined();
    const theirs = JSON.stringify({
      sandbox: {
        enabled: false,
        failIfUnavailable: true,
        filesystem: { denyRead: ["~/.kube", "~/.ssh"], allowRead: ["."] },
        network: { allowedDomains: ["github.com"], allowLocalBinding: true },
      },
    });
    expect(settings(theirs, "none").sandbox).toEqual(JSON.parse(theirs).sandbox);
    const merged = settings(theirs).sandbox as {
      enabled: boolean;
      failIfUnavailable: boolean;
      filesystem: Record<string, string[]>;
      network: Record<string, unknown>;
    };
    expect([merged.enabled, merged.failIfUnavailable]).toEqual([true, true]);
    expect(merged.filesystem).toEqual({
      denyRead: ["~/.kube", "~/.ssh", "~/.aws"],
      allowRead: ["."],
      allowWrite: ["/tmp/build"],
    });
    expect(merged.network).toEqual({
      allowedDomains: ["github.com", "registry.npmjs.org"],
      allowLocalBinding: true,
    });
    // Generating again changes nothing.
    expect(settings(JSON.stringify({ sandbox: merged })).sandbox).toEqual(merged as never);
  });

  test("the user's settings and own hooks stay; earlier metator hooks are replaced, not duplicated", () => {
    const existing = JSON.stringify({
      model: "opus",
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "./my-check.sh" },
              { type: "command", command: "npx metator guard pre-tool" },
            ],
          },
        ],
        Notification: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
      },
    });
    const once = new ClaudeGenerator().hooks("bun run metator", existing)._unsafeUnwrap().content;
    const twice = new ClaudeGenerator().hooks("bun run metator", once)._unsafeUnwrap().content;
    expect(twice).toBe(once);
    const settings = JSON.parse(once) as Settings;
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Notification).toEqual([
      { hooks: [{ type: "command", command: "notify-send done" }] },
    ] as never);
    expect(settings.hooks.PreToolUse?.map((g) => g.hooks.map((h) => h.command))).toEqual([
      ["./my-check.sh"],
      ["bun run metator guard pre-tool"],
    ]);
  });

  test("an unreadable settings file is an error value", () => {
    expect(new ClaudeGenerator().hooks("metator", "{ nope")._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
  });
});

describe("ClaudeSkillGenerator", () => {
  test("SKILL.md and its files under .claude/skills/<name>/, marked as generated", () => {
    const skill = {
      name: "mt-find-patterns",
      description: "Use when a plan needs an exemplar. Do not use for search.",
      files: ["scripts/a.sh"],
    };
    const files = new ClaudeSkillGenerator().skill(
      skill,
      "# When\nx\n",
      [{ path: "scripts/a.sh", content: "echo" }],
      { source: "metator/skills/mt-find-patterns/SKILL.md" },
    );
    expect(files.map((f) => f.path)).toEqual([
      ".claude/skills/mt-find-patterns/SKILL.md",
      ".claude/skills/mt-find-patterns/scripts/a.sh",
    ]);
    expect(files[0]?.content).toContain(
      "<!-- generated by metator generate from metator/skills/mt-find-patterns/SKILL.md",
    );
    expect(new ClaudeSkillGenerator().owns).toBe(".claude/skills/*/SKILL.md");
  });
});

describe("claudeHost", () => {
  test("the descriptor: its program, agents through the SDK, a session, and the files it writes", () => {
    expect(claudeHost.id).toBe("claude");
    expect(claudeHost.program).toEqual({ env: "METATOR_CLAUDE_BIN", default: "claude" });
    expect([claudeHost.agent?.runsProgram, claudeHost.agent?.host(undefined).id]).toEqual([false, "claude"]);
    expect(claudeHost.interactive?.(new FakeTerminal(), "/opt/claude").id).toBe("claude");
    expect(claudeHost.files?.agentFile("mt-x")).toBe(".claude/agents/mt-x.md");
    expect([claudeHost.files?.generator().host, claudeHost.files?.skills().owns]).toEqual([
      "claude",
      ".claude/skills/*/SKILL.md",
    ]);
  });

  test("the program given for the host is the one its session starts", async () => {
    const terminal = new FakeTerminal();
    const task = { agent: "a", prompt: "p", cwd: "/w", projectRoot: "/w", runDir: "/w/.metator/runs/r" };
    await claudeHost.interactive?.(terminal, "/opt/claude").start(task, { cols: 80, rows: 24 });
    await claudeHost.interactive?.(terminal, undefined).start(task, { cols: 80, rows: 24 });
    expect(terminal.spawned.map((s) => s.argv[0])).toEqual(["/opt/claude", "claude"]);
  });

  test("an agent's generated file is where the descriptor says agents are", () => {
    const file = claudeHost.files?.generator().agent(agent({}), BODY, {
      source: "metator/agents/mt-x.md",
      metatorCommand: "metator",
    });
    expect(file?.path).toBe(claudeHost.files?.agentFile("mt-x") as string);
  });
});
