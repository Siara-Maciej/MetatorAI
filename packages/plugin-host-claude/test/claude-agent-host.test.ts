import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentQuestion } from "@metator/core";
import { agentHostContract, collect } from "@metator/testing";
import {
  agentDefinition,
  ClaudeAgentHost,
  type ClaudeQuery,
  declaredCommands,
  toEvents,
} from "../src/claude-agent-host.ts";

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

  test("the agent's narrow command grants are pre-approved; broad tools are not", async () => {
    const root = await mkdtemp(join(tmpdir(), "metator-claude-"));
    await Bun.write(
      join(root, ".claude/agents/mt-planner.md"),
      "---\nname: mt-planner\ntools: Read, Edit, Bash, Bash(metator plan:*), Bash(bun run metator graph:*)\n---\n# Role\ntools: Bash(not:*)\n",
    );
    const { query, calls } = fakeQuery(async () => [init, success]);
    await collect(new ClaudeAgentHost(query), { ...task, projectRoot: root });
    expect(calls[0]?.options.allowedTools).toEqual(["Bash(metator plan:*)", "Bash(bun run metator graph:*)"]);
    // No agent file (or no tools line): nothing is pre-approved.
    expect(declaredCommands(join(root, "missing.md"))).toEqual([]);
    await Bun.write(join(root, "plain.md"), "# no front matter\n");
    expect(declaredCommands(join(root, "plain.md"))).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  test("the agent is defined for the session from the project's file, so it applies in a folder too", async () => {
    const root = await mkdtemp(join(tmpdir(), "metator-claude-"));
    await Bun.write(
      join(root, ".claude/agents/mt-guide.md"),
      "---\nname: mt-guide\ndescription: Answers questions\ntools: Read, Glob, Grep, Agent(mt-a, mt-b), Bash(metator graph:*)\nmodel: sonnet\n---\n<!-- generated -->\n\n# Role\nYou answer.\n",
    );
    const { query, calls } = fakeQuery(async () => [init, success]);
    // A folder of repositories: the session works in the folder, the agent comes from a repository.
    await collect(new ClaudeAgentHost(query), {
      ...task,
      agent: "mt-guide",
      cwd: "/folder",
      projectRoot: root,
    });
    expect(calls[0]?.options.agents).toEqual({
      "mt-guide": {
        description: "Answers questions",
        prompt: "<!-- generated -->\n\n# Role\nYou answer.",
        tools: ["Read", "Glob", "Grep", "Agent(mt-a, mt-b)", "Bash(metator graph:*)"],
        model: "sonnet",
      },
    });
    expect(agentDefinition(join(root, "missing.md"))).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  test("a search through the shell that only reads runs without a person; anything else asks", async () => {
    const asked: string[] = [];
    const { query } = fakeQuery(async (can) => {
      await can("Bash", { command: 'grep -rn "offers" backend/src --include=*.ts' });
      await can("Bash", { command: "find . -name '*.ts' -delete" });
      return [init, success];
    });
    await collect(new ClaudeAgentHost(query), { ...task, cwd: "/folder" }, async (q) => {
      asked.push(q.prompt);
      return { choices: ["Deny"] };
    });
    expect(asked).toEqual(["mt-planner wants to use Bash: find . -name '*.ts' -delete"]);
  });

  test("the directories a folder's linked repositories really are in are readable and searchable", async () => {
    const asked: string[] = [];
    const { query, calls } = fakeQuery(async (can) => {
      await can("Bash", { command: "grep -rn offers /clones/api/src" });
      await can("Bash", { command: "grep -rn offers /clones/other/src" });
      return [init, success];
    });
    await collect(
      new ClaudeAgentHost(query),
      { ...task, cwd: "/folder", dirs: ["/clones/api"] },
      async (q) => {
        asked.push(q.prompt);
        return { choices: ["Deny"] };
      },
    );
    expect(calls[0]?.options.additionalDirectories).toEqual(["/repo/.metator/runs/r", "/clones/api"]);
    expect(asked).toEqual(["mt-planner wants to use Bash: grep -rn offers /clones/other/src"]);
  });

  test("a tool call on a file that may hold secrets is denied in-process, wherever the session works", async () => {
    const { query, calls } = fakeQuery(async () => [init, success]);
    await collect(new ClaudeAgentHost(query), { ...task, cwd: "/folder" });
    type Hook = (input: unknown) => Promise<{ hookSpecificOutput?: { permissionDecision: string } }>;
    const hooks = calls[0]?.options.hooks as { PreToolUse: { hooks: Hook[] }[] };
    const hook = hooks.PreToolUse[0]?.hooks[0] as Hook;
    const decision = async (tool_name: string, tool_input: Record<string, unknown>) =>
      (await hook({ hook_event_name: "PreToolUse", tool_name, tool_input })).hookSpecificOutput
        ?.permissionDecision;
    expect(await decision("Read", { file_path: "/folder/backend/.env.secret" })).toBe("deny");
    expect(await decision("Bash", { command: "cat backend/.env.local" })).toBe("deny");
    expect(await decision("Read", { file_path: "/folder/backend/src/main.ts" })).toBeUndefined();
    expect(await decision("Read", { file_path: "/folder/backend/.env.example" })).toBeUndefined();
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

  test("writing the run's own artifacts needs no person; a write anywhere else asks", async () => {
    const decisions: unknown[] = [];
    const { query } = fakeQuery(async (can) => {
      decisions.push(await can("Write", { file_path: "/repo/.metator/runs/r/analysis.json", content: "{}" }));
      decisions.push(await can("Edit", { file_path: "/repo/.metator/runs/r/sub/x.md" }));
      decisions.push(await can("Write", { file_path: "/repo/.metator/runs/r/../r2/analysis.json" }));
      decisions.push(await can("Write", { file_path: "/repo/packages/a.ts" }));
      return [init, success];
    });
    const asked: string[] = [];
    await collect(new ClaudeAgentHost(query), task, async (q) => {
      asked.push(q.prompt);
      return { choices: ["Deny"], text: "not there" };
    });
    expect(decisions).toEqual([
      {
        behavior: "allow",
        updatedInput: { file_path: "/repo/.metator/runs/r/analysis.json", content: "{}" },
      },
      { behavior: "allow", updatedInput: { file_path: "/repo/.metator/runs/r/sub/x.md" } },
      { behavior: "deny", message: "not there" },
      { behavior: "deny", message: "not there" },
    ]);
    expect(asked).toHaveLength(2);
  });

  test("in the run's own worktree edits need no person; in the checkout itself they ask", async () => {
    const decisions: unknown[] = [];
    const asked: string[] = [];
    const run = async (t: typeof task) => {
      const { query } = fakeQuery(async (can) => {
        decisions.push(await can("Edit", { file_path: `${t.cwd}/packages/a.ts` }));
        return [init, success];
      });
      await collect(new ClaudeAgentHost(query), t, async (q) => {
        asked.push(q.prompt);
        return { choices: ["Deny"], text: "no" };
      });
    };
    await run(task); // cwd is the run's worktree
    await run({ ...task, cwd: "/repo" }); // no worktree: the person's own checkout
    expect(decisions.map((d) => (d as { behavior: string }).behavior)).toEqual(["allow", "deny"]);
    expect(asked).toEqual(['mt-planner wants to use Edit: {"file_path":"/repo/packages/a.ts"}']);
  });

  test("a person sees a command whole before deciding on it", async () => {
    const long = `echo ${"x".repeat(500)} && rm -rf build`;
    const { query } = fakeQuery(async (can) => {
      await can("Bash", { command: long });
      return [init, success];
    });
    const asked: string[] = [];
    await collect(new ClaudeAgentHost(query), task, async (q) => {
      asked.push(q.prompt);
      return { choices: ["Deny"], text: "no" };
    });
    expect(asked).toEqual([`mt-planner wants to use Bash: ${long}`]);
  });

  test("a write through a link to the run directory (from a worktree) is a write into the run", async () => {
    const root = await mkdtemp(join(tmpdir(), "metator-link-"));
    const runDir = join(root, ".metator/runs/r");
    await mkdir(runDir, { recursive: true });
    await mkdir(join(root, ".metator/wt/r/.metator"), { recursive: true });
    await symlink(join(root, ".metator/runs"), join(root, ".metator/wt/r/.metator/runs"));
    const decisions: unknown[] = [];
    const { query } = fakeQuery(async (can) => {
      decisions.push(await can("Edit", { file_path: join(root, ".metator/wt/r/.metator/runs/r/plan.json") }));
      decisions.push(await can("Write", { file_path: join(root, ".metator/wt/r/src/a.ts") }));
      return [init, success];
    });
    await collect(new ClaudeAgentHost(query), { ...task, runDir }, async () => ({
      choices: ["Deny"],
      text: "no",
    }));
    expect(decisions.map((d) => (d as { behavior: string }).behavior)).toEqual(["allow", "deny"]);
    await rm(root, { recursive: true, force: true });
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
