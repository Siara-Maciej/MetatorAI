import { describe, expect, test } from "bun:test";
import { AgentDocument } from "@metator/core";
import { ClaudeGenerator } from "../src/claude-generator.ts";
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
