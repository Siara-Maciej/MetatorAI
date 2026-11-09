import { describe, expect, test } from "bun:test";
import { describeCommands, describeOverview, renderOverview, VERBS } from "../src/commands/meta.ts";
import { buildProgram } from "../src/program.ts";

describe("the overview by verb (metator help --verbs)", () => {
  const program = buildProgram(() => {});
  const overview = describeOverview(program);

  test("every command a verb names exists; every top-level command group is reached from some verb", () => {
    const all = describeCommands(program).commands.map((c) => c.name);
    for (const g of VERBS)
      for (const [name] of g.commands)
        expect(all.some((c) => c === name || c.startsWith(`${name} `))).toBe(true);
    const reached = new Set(VERBS.flatMap((g) => g.commands.map(([name]) => name.split(" ")[0] as string)));
    // Groups for agents and plumbing stay out of the overview on purpose: hooks, canon tooling, internals.
    const plumbing = new Set([
      "version",
      "help",
      "changed",
      "index",
      "api",
      "contract",
      "coverage",
      "debug-tags",
      "discover",
      "docs",
      "eval",
      "flaky",
      "guard",
      "lessons",
      "memory",
      "meta",
      "pane",
      "patterns",
      "plan",
      "policy",
      "rules",
      "similar",
      "test",
      "workspace",
      "config",
      "adr",
      "findings",
      "review",
      "arch",
      "graph",
      "symbols",
      "cards",
      "owners",
      "workflow",
    ]);
    const top = new Set(all.map((c) => c.split(" ")[0] as string));
    for (const t of top) if (!plumbing.has(t)) expect([t, reached.has(t)]).toEqual([t, true]);
    expect(overview.total).toBe(all.length);
    expect(overview.verbs.map((v) => v.verb)).toEqual(VERBS.map((v) => v.verb));
    expect(overview.verbs[1]?.commands.find((c) => c.name === "run init")?.usage).toBe(
      "metator run init [options]",
    );
  });

  test("renders as text a person reads: the version, the verbs, the commands aligned, how to see the rest", () => {
    const text = renderOverview(overview);
    expect(text).toStartWith("MetatorAI 0.0.0: survey first, prove everything.");
    expect(text).toMatch(/\nWork on a task\n {2}metator run {2,}start a run in the terminal/);
    expect(text).toContain("  metator run init ");
    expect(text).toContain("`metator help`");
    expect(text).not.toContain(String.fromCharCode(27));
  });
});
