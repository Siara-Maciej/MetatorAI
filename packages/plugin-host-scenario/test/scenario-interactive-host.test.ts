import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentScenario } from "@metator/core";
import { NodePtyTerminal } from "@metator/plugin-node";
import { interactiveHostContract, outputUntil } from "@metator/testing";
import { ScenarioInteractiveHost } from "../src/scenario-interactive-host.ts";

const scenario: AgentScenario = {
  agents: {
    session: [
      [
        { say: "Planning the change in {cwd}" },
        {
          ask: {
            question: "Round half up or half even?",
            options: ["half-up", "half-even"],
            multiSelect: false,
          },
        },
        { write: { path: "{cwd}/notes.txt", text: "done\n" } },
        { say: "STATUS: done" },
      ],
      [{ say: "Resumed" }, { fail: "no more" }],
    ],
  },
};

const task = (cwd: string) => ({
  agent: "session",
  prompt: "Add discount",
  cwd,
  projectRoot: cwd,
  runDir: join(cwd, ".metator/runs/r"),
});

interactiveHostContract("ScenarioInteractiveHost", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "metator-scenario-pty-"));
  return {
    host: new ScenarioInteractiveHost(new NodePtyTerminal(), scenario),
    task: task(cwd),
    says: `Planning the change in ${cwd}`,
    answer: { type: "half-even", echoes: "answer: half-even" },
  };
});

describe("ScenarioInteractiveHost", () => {
  test("a write step writes the file; a resumed session plays the next entry and fails as scripted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "metator-scenario-pty-"));
    const host = new ScenarioInteractiveHost(new NodePtyTerminal(), scenario);
    const first = (await host.start(task(cwd), { cols: 80, rows: 24 }))._unsafeUnwrap();
    await outputUntil(first.pty, "half even?");
    first.pty.write("half-up\r");
    await outputUntil(first.pty, "STATUS: done");
    await Bun.sleep(100);
    expect(await Bun.file(join(cwd, "notes.txt")).text()).toBe("done\n");
    const again = (await host.resume(first.sessionId, task(cwd), { cols: 80, rows: 24 }))._unsafeUnwrap();
    const out = await outputUntil(again.pty, "no more");
    expect(out).toContain("Resumed");
    expect(again.sessionId).toBe("scenario-session-2");
    await rm(cwd, { recursive: true, force: true });
  }, 30_000);

  test("a scenario without a session entry cannot start", async () => {
    const host = new ScenarioInteractiveHost(new NodePtyTerminal(), { agents: {} });
    const r = await host.start(task(tmpdir()), { cols: 80, rows: 24 });
    expect(r._unsafeUnwrapErr().message).toContain("no `session` or `session` entry");
  });

  test("an agent with its own entry plays it; others fall back to the session entry", async () => {
    const host = new ScenarioInteractiveHost(new NodePtyTerminal(), {
      agents: { ...scenario.agents, "mt-planner": [[{ say: "planner here" }]] },
    });
    const planner = (await host.launch({ ...task(tmpdir()), agent: "mt-planner" }))._unsafeUnwrap();
    expect([planner.sessionId, planner.argv[2]]).toEqual([
      "scenario-mt-planner-1",
      expect.stringContaining("planner here"),
    ]);
    const other = (await host.launch({ ...task(tmpdir()), agent: "mt-implementer" }))._unsafeUnwrap();
    expect([other.sessionId, other.argv[2]]).toEqual([
      "scenario-mt-implementer-1",
      expect.stringContaining("Planning the change"),
    ]);
  });
});
