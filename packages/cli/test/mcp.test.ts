import { describe, expect, test } from "bun:test";
import { describeCommands } from "../src/commands/meta.ts";
import { ALWAYS, mcpTools, REFUSED, TYPED, toolArgv, toolCall } from "../src/mcp.ts";
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

  const optionsOf = (command: string) => {
    let cmd = program;
    for (const word of command.split(" "))
      cmd = cmd.commands.find((c) => c.name() === word) as typeof program;
    return cmd.options;
  };
  const tool = (command: string) => tools.find((x) => x.command === command) as (typeof tools)[number];

  test("a reading tool cannot write: an option that writes or reaches outside is refused by name", () => {
    const refused = (command: string, args: string[]) => {
      const e = toolCall(tool(command), { args })._unsafeUnwrapErr();
      return [e.code, e.message];
    };
    expect(refused("review metadata", ["--out", "f.json"])).toEqual([
      "USAGE",
      "the tool metator_review_metadata only reads: --out is refused",
    ]);
    expect(refused("review diff", ["--base", "main", "--out=f.patch"])[1]).toContain("--out is refused");
    expect(refused("review plan", ["--out", "p.json"])[0]).toBe("USAGE");
    expect(refused("arch check", ["--sarif", "a.sarif"])[1]).toContain("--sarif");
    expect(refused("memory validate", ["--fix"])[1]).toContain("--fix");
    expect(refused("docs drift", ["--fix"])[1]).toContain("--fix");
    expect(refused("system lint", ["--fetch"])[1]).toContain("--fetch");
    expect(refused("system sources", ["--fetch"])[1]).toContain("--fetch");
    expect(refused("worktree conflicts", ["--notify"])[1]).toContain("--notify");
    expect(refused("report", ["--html", "r.html"])[1]).toContain("--html");
    // The same words as an argument (after `--`), or on a tool where they do not write, pass.
    expect(toolCall(tool("review diff"), { args: ["--base", "main"] })._unsafeUnwrap()).toEqual([
      "review",
      "diff",
      "--base",
      "main",
    ]);
    expect(toolCall(tool("symbols find"), { name: "x", args: ["--", "--out"] }).isOk()).toBe(true);
    expect(tool("review diff").description).toContain("--out is refused");
    expect(refused("doctor", ["--gates"])[1]).toContain("--gates");
  });

  test("plan scope as a tool computes the scope and never writes it", () => {
    expect(toolCall(tool("plan scope"), { file: "plan.json" })._unsafeUnwrap()).toEqual([
      "plan",
      "scope",
      "plan.json",
      "--dry-run",
    ]);
    // Asked twice, the flag is passed once.
    expect(toolCall(tool("plan scope"), { args: ["plan.json", "--dry-run"] })._unsafeUnwrap()).toEqual([
      "plan",
      "scope",
      "plan.json",
      "--dry-run",
    ]);
    for (const args of [["--out", "elsewhere.json"], ["--out=elsewhere.json"]]) {
      const e = toolCall(tool("plan scope"), { file: "plan.json", args })._unsafeUnwrapErr();
      expect([e.code, e.message]).toEqual([
        "USAGE",
        "the tool metator_plan_scope only reads: --out is refused",
      ]);
    }
    expect(tool("plan scope").description).toContain("--out is refused");
  });

  test("the refused and the added options are real options of their commands; no other option of a tool writes", () => {
    for (const [command, flags] of [...Object.entries(REFUSED), ...Object.entries(ALWAYS)]) {
      expect([command, tools.some((t) => t.command === command)]).toEqual([command, true]);
      for (const flag of flags)
        expect([command, flag, optionsOf(command).some((o) => o.long === flag)]).toEqual([
          command,
          flag,
          true,
        ]);
    }
    const writes = /\b(write|rewrite|clone|tell|send|save|fix|fetch|notify)\b/i;
    const open = tools.flatMap((t) =>
      optionsOf(t.command)
        .filter((o) => writes.test(`${o.long} ${o.description}`))
        .filter((o) => !(REFUSED[t.command] ?? []).includes(o.long as string))
        .map((o) => `${t.command} ${o.long}`),
    );
    // `similar --file` names a file the caller is about to write; `--by` of worktree conflicts
    // only names the sender of what `--notify` (refused) sends.
    expect(open).toEqual(["similar --file", "worktree conflicts --by"]);
  });

  test("run brief as a tool never marks the run as read", () => {
    expect(toolCall(tool("run brief"), {})._unsafeUnwrap()).toEqual(["run", "brief", "--peek"]);
    expect(toolCall(tool("run brief"), { args: ["--peek", "--run", "r1"] })._unsafeUnwrap()).toEqual([
      "run",
      "brief",
      "--peek",
      "--run",
      "r1",
    ]);
  });

  test("a call's command line: the words, typed positionals and flags, then the raw arguments", () => {
    const deps = tools.find((x) => x.command === "graph deps") as (typeof tools)[number];
    expect(toolArgv(deps, { args: ["src/a.ts", "--transitive"] })).toEqual([
      "graph",
      "deps",
      "src/a.ts",
      "--transitive",
    ]);
    expect(toolArgv(deps, { file: "src/a.ts", transitive: true })).toEqual([
      "graph",
      "deps",
      "src/a.ts",
      "--transitive",
    ]);
    expect(toolArgv(deps, { file: "src/a.ts", transitive: false, args: ["--json"] })).toEqual([
      "graph",
      "deps",
      "src/a.ts",
      "--json",
    ]);
    const pack = tools.find((x) => x.command === "rules pack") as (typeof tools)[number];
    expect(toolArgv(pack, { files: ["a.ts", "b.ts"], budget: 2000 })).toEqual([
      "rules",
      "pack",
      "--files",
      "a.ts",
      "b.ts",
      "--budget",
      "2000",
    ]);
    // The field's name before the flag was renamed is still heard; the new one wins.
    expect(toolArgv(pack, { paths: ["a.ts"] })).toEqual(["rules", "pack", "--files", "a.ts"]);
    expect(toolArgv(pack, { files: ["b.ts"], paths: ["a.ts"] })).toEqual([
      "rules",
      "pack",
      "--files",
      "b.ts",
    ]);
    const path = tools.find((x) => x.command === "graph path") as (typeof tools)[number];
    expect(toolArgv(path, { from: "a.ts", to: "b.ts" })).toEqual(["graph", "path", "a.ts", "b.ts"]);
    // A tool without a shape takes args alone; every typed tool is a real command with those options.
    const version = tools.find((x) => x.command === "version") as (typeof tools)[number];
    expect([version.shape, toolArgv(version, { file: "ignored" })]).toEqual([undefined, ["version"]]);
    expect(
      tools
        .filter((t) => t.shape)
        .map((t) => t.command)
        .sort(),
    ).toEqual(Object.keys(TYPED).sort());
  });
});
