import { describe, expect, test } from "bun:test";
import { describeCommands } from "../src/commands/meta.ts";
import { mcpTools, toolArgv } from "../src/mcp.ts";
import { buildProgram } from "../src/program.ts";

describe("the MCP tools (metator mcp)", () => {
  const program = buildProgram(() => {});
  const tools = mcpTools(program);
  const all = describeCommands(program).commands.map((c) => c.name);

  test("every tool is a command of the tree, named by its words; a prefix takes its whole group", () => {
    for (const t of tools) expect([t.command, all.includes(t.command)]).toEqual([t.command, true]);
    expect(tools.map((t) => t.name)).toContain("metator_graph_affected");
    expect(tools.find((t) => t.command === "graph cycles")?.name).toBe("metator_graph_cycles");
    expect(tools.find((t) => t.command === "debug-tags check")?.name).toBe("metator_debug_tags_check");
    expect(tools.filter((t) => t.command.startsWith("graph ")).length).toBe(
      all.filter((c) => c.startsWith("graph ")).length,
    );
    expect(tools.find((t) => t.command === "run status")?.description).toContain("metator run status --help");
  });

  test("nothing that writes, runs the project's scripts, drives a run or talks to an AI host is a tool", () => {
    const never = [
      "run init",
      "run advance",
      "run approve",
      "run answer",
      "run drive",
      "run start",
      "run delegate",
      "run collect",
      "run close",
      "run write",
      "gate",
      "test affected",
      "setup",
      "init",
      "generate",
      "agents install",
      "agents update",
      "worktree new",
      "worktree rm",
      "env up",
      "env down",
      "ask",
      "serve",
      "supervise",
      "attach",
      "mcp",
      "findings to-github",
      "lessons add",
      "policy rm",
      "arch plan approve",
      "system plan approve",
      "rules scaffold",
      "cards build",
      "index build",
    ];
    for (const n of never) {
      expect([n, all.includes(n)]).toEqual([n, true]);
      expect([n, tools.some((t) => t.command === n)]).toEqual([n, false]);
    }
    expect(tools.length).toBeGreaterThan(50);
    expect(tools.length).toBeLessThan(all.length / 2);
  });

  test("a call's command line is the tool's words then the caller's arguments", () => {
    const t = tools.find((x) => x.command === "graph deps");
    expect(toolArgv(t as NonNullable<typeof t>, ["src/a.ts", "--transitive"])).toEqual([
      "graph",
      "deps",
      "src/a.ts",
      "--transitive",
    ]);
  });
});
