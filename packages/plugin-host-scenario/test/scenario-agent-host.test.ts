import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentHostContract, collect } from "@metator/testing";
import { ScenarioAgentHost } from "../src/scenario-agent-host.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "metator-scenario-"));
  dirs.push(d);
  return d;
}
const task = (cwd: string, agent = "mt-planner") => ({
  agent,
  prompt: "p",
  cwd,
  projectRoot: cwd,
  runDir: `${cwd}/run`,
});

agentHostContract("ScenarioAgentHost", async () => ({
  host: new ScenarioAgentHost({ agents: { "mt-planner": [[{ say: "Planning" }]] } }),
  task: task(await dir()),
}));

describe("ScenarioAgentHost", () => {
  test("steps play in order: say, write (worktree or run directory), tool, ask", async () => {
    const cwd = await dir();
    const host = new ScenarioAgentHost({
      agents: {
        "mt-planner": [
          [
            { write: { path: "{runDir}/plan.md", text: "plan for {cwd}" } },
            { write: { path: "src/a.ts", text: "export {};\n" } },
            { tool: { name: "Bash", summary: "bun test" } },
            { ask: { question: "Which?", options: ["A", "B"], multiSelect: false } },
            { say: "STATUS: done" },
          ],
        ],
      },
    });
    const events = await collect(host, task(cwd), async () => ({ choices: ["B"] }));
    expect(await Bun.file(join(cwd, "run/plan.md")).text()).toBe(`plan for ${cwd}`);
    expect(await Bun.file(join(cwd, "src/a.ts")).exists()).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["session", "tool", "tool", "tool", "text", "text", "result"]);
    expect(events.at(-1)).toEqual({ type: "result", ok: true, text: "answer: B\nSTATUS: done" });
  });

  test("the n-th start plays the n-th entry and the last repeats; fail ends with a failed result", async () => {
    const host = new ScenarioAgentHost({ agents: { a: [[{ say: "one" }], [{ fail: "two" }]] } });
    const cwd = await dir();
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await collect(host, task(cwd, "a"))).at(-1));
    expect(results).toEqual([
      { type: "result", ok: true, text: "one" },
      { type: "result", ok: false, text: "two" },
      { type: "result", ok: false, text: "two" },
    ]);
    expect((await collect(host, task(cwd, "zzz"))).at(-1)).toMatchObject({ ok: false });
  });

  test("a scenario file is read at the first start; a missing or invalid one is a failed result", async () => {
    const d = await dir();
    await Bun.write(
      join(d, "s.yml"),
      "kind: AgentScenario\nschemaVersion: 1\nagents:\n  a:\n    - - say: hi\n",
    );
    expect((await collect(new ScenarioAgentHost(join(d, "s.yml")), task(d, "a"))).at(-1)).toMatchObject({
      ok: true,
    });
    await Bun.write(
      join(d, "bad.yml"),
      "kind: AgentScenario\nschemaVersion: 1\nagents:\n  a:\n    - - shout: hi\n",
    );
    const bad = (await collect(new ScenarioAgentHost(join(d, "bad.yml")), task(d, "a"))).at(-1);
    expect(bad).toMatchObject({ type: "result", ok: false });
    const none = (await collect(new ScenarioAgentHost(join(d, "nope.yml")), task(d, "a"))).at(-1);
    expect(none).toMatchObject({ ok: false });
  });
});
