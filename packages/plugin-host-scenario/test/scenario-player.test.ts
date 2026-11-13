import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentScenario } from "@metator/core";
import { ScenarioPlayer } from "../src/scenario-player.ts";

const scenario: AgentScenario = {
  agents: {
    "mt-planner": [[{ say: "one" }], [{ say: "two" }]],
    session: [[{ say: "stand-in" }]],
  },
};

describe("ScenarioPlayer", () => {
  test("each start of an agent takes its next entry; the last entry repeats", async () => {
    const player = new ScenarioPlayer(scenario);
    const turns = [];
    for (let i = 0; i < 3; i++) turns.push((await player.next("mt-planner", 0))._unsafeUnwrap());
    expect(turns.map((t) => t?.steps)).toEqual([[{ say: "one" }], [{ say: "two" }], [{ say: "two" }]]);
    expect(turns.map((t) => t?.sessionId)).toEqual([
      "scenario-mt-planner-1",
      "scenario-mt-planner-2",
      "scenario-mt-planner-3",
    ]);
  });

  test("a continued session (a new process) plays the entry after the turns it already played", async () => {
    const turn = (await new ScenarioPlayer(scenario).next("mt-planner", 1))._unsafeUnwrap();
    expect(turn).toEqual({ steps: [{ say: "two" }], sessionId: "scenario-mt-planner-2" });
  });

  test("agents count their starts separately", async () => {
    const player = new ScenarioPlayer(scenario);
    await player.next("mt-planner", 0);
    expect((await player.next("session", 0))._unsafeUnwrap()?.sessionId).toBe("scenario-session-1");
  });

  test("an agent the scenario does not list plays the stand-in entry, or nothing without one", async () => {
    const player = new ScenarioPlayer(scenario);
    expect((await player.next("mt-coder", 0))._unsafeUnwrap()).toBeUndefined();
    expect((await player.next("mt-coder", 0, "session"))._unsafeUnwrap()).toEqual({
      steps: [{ say: "stand-in" }],
      sessionId: "scenario-mt-coder-1",
    });
    expect((await player.next("mt-coder", 0, "nobody"))._unsafeUnwrap()).toBeUndefined();
  });

  test("a scenario file is read once, at the first start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-player-"));
    const file = join(dir, "scenario.yml");
    await writeFile(file, "kind: AgentScenario\nschemaVersion: 1\nagents:\n  a:\n    - - say: hello\n");
    const player = new ScenarioPlayer(file);
    expect((await player.next("a", 0))._unsafeUnwrap()?.steps).toEqual([{ say: "hello" }]);
    await writeFile(file, "broken: [");
    expect((await player.next("a", 0))._unsafeUnwrap()?.sessionId).toBe("scenario-a-2");
  });

  test("a missing or invalid scenario file is an error value with the reason", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-player-"));
    const missing = await new ScenarioPlayer(join(dir, "none.yml")).next("a", 0);
    expect(missing._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    await writeFile(join(dir, "bad.yml"), "agents: [");
    expect((await ScenarioPlayer.load(join(dir, "bad.yml")))._unsafeUnwrapErr().code).toBe("PARSE_FAILED");
  });
});
