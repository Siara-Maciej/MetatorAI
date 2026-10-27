import { describe, expect, test } from "bun:test";
import type { AgentQuestion } from "@metator/core";
import { agentHostContract, collect } from "@metator/testing";
import { ClaudeAgentHost, type ClaudeQuery, toEvents } from "../src/claude-agent-host.ts";

const task = {
  agent: "mt-planner",
  prompt: "Plan it",
  cwd: "/repo/.metator/wt/r",
  projectRoot: "/repo",
  runDir: "/repo/.metator/runs/r",
};

/** A fake query(): records its options and replays SDK messages, calling canUseTool on the way. */
function fakeQuery(
  script: (
    canUseTool: (t: string, i: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<Record<string, unknown>[]>,
) {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  const query: ClaudeQuery = async function* (params) {
    calls.push(params);
    const can = params.options.canUseTool as (t: string, i: Record<string, unknown>) => Promise<unknown>;
    for (const m of await script(can)) yield m;
  };
  return { query, calls };
}

const init = { type: "system", subtype: "init", session_id: "s-1" };
const said = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const success = { type: "result", subtype: "success", is_error: false, result: "STATUS: done" };

agentHostContract("ClaudeAgentHost", async () => ({
  host: new ClaudeAgentHost(fakeQuery(async () => [init, said("Planning"), success]).query),
  task,
}));

describe("ClaudeAgentHost", () => {
  test("runs the canonical agent in the worktree with the project's .claude/ and resumes a session", async () => {
    const { query, calls } = fakeQuery(async () => [init, success]);
    await collect(new ClaudeAgentHost(query), { ...task, resume: "s-0" });
    expect(calls[0]?.prompt).toBe("Plan it");
    expect(calls[0]?.options).toMatchObject({
      cwd: "/repo/.metator/wt/r",
      agent: "mt-planner",
      settingSources: ["project"],
      projectConfigRoot: "/repo",
      additionalDirectories: ["/repo/.metator/runs/r"],
      resume: "s-0",
    });
    const inRepo = fakeQuery(async () => [init, success]);
    await collect(new ClaudeAgentHost(inRepo.query), { ...task, cwd: "/repo" });
    expect(inRepo.calls[0]?.options.projectConfigRoot).toBeUndefined();
  });

  test("AskUserQuestion goes to a person; the answers return keyed by question", async () => {
    let returned: unknown;
    const { query } = fakeQuery(async (can) => {
      returned = await can("AskUserQuestion", {
        questions: [
          {
            question: "Currency?",
            header: "Money",
            options: [{ label: "EUR" }, { label: "USD" }],
            multiSelect: false,
          },
        ],
      });
      return [init, success];
    });
    const asked: AgentQuestion[] = [];
    await collect(new ClaudeAgentHost(query), task, async (q) => {
      asked.push(q);
      return { choices: ["EUR"] };
    });
    expect(asked[0]).toMatchObject({ source: "agent", prompt: "Money: Currency?", multiSelect: false });
    expect(returned).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Currency?": "EUR" } } });
  });

  test("a permission prompt is a question: Allow runs the call, Deny refuses it with the reason", async () => {
    const decisions: unknown[] = [];
    const { query } = fakeQuery(async (can) => {
      decisions.push(await can("Bash", { command: "rm -rf build" }));
      decisions.push(await can("Bash", { command: "git push" }));
      return [init, success];
    });
    let n = 0;
    await collect(new ClaudeAgentHost(query), task, async (q) => {
      expect(q.source).toBe("permission");
      return n++ === 0 ? { choices: ["Allow"] } : { choices: ["Deny"], text: "no pushes from runs" };
    });
    expect(decisions).toEqual([
      { behavior: "allow", updatedInput: { command: "rm -rf build" } },
      { behavior: "deny", message: "no pushes from runs" },
    ]);
  });

  test("SDK messages become host-neutral events; an error result is not ok", () => {
    expect([...toEvents(init)]).toEqual([{ type: "session", id: "s-1" }]);
    const tool = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }] },
    };
    expect([...toEvents(tool)]).toEqual([{ type: "tool", name: "Edit", summary: '{"file_path":"a.ts"}' }]);
    const failed = { type: "result", subtype: "error_max_turns", is_error: true, errors: ["too many turns"] };
    expect([...toEvents(failed)]).toEqual([
      { type: "result", ok: false, text: "error_max_turns: too many turns" },
    ]);
    expect([...toEvents({ type: "user" })]).toEqual([]);
  });
});
