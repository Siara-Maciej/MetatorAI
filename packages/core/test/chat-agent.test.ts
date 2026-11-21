import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryFileSystem } from "@metator/testing";
import { AgentCatalog, LintAgents } from "../src/application/agents.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { metatorGroups } from "../src/domain/agent.ts";

const ROOT = join(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const SOURCE = "metator/agents/mt-chat.md";
const text = read(SOURCE);
const body = text.slice(text.indexOf("\n---\n", 4) + 5);
const section = (heading: string) => {
  const from = body.indexOf(heading);
  const next = body.indexOf("\n## ", from + heading.length);
  const top = body.indexOf("\n# ", from + heading.length);
  const ends = [next, top].filter((i) => i > 0);
  return body.slice(from, ends.length > 0 ? Math.min(...ends) : undefined);
};

/** The conversation agent's prompt (ADR-0093): what it must say, on both hosts. */
describe("mt-chat: the conversation agent", () => {
  test("it is a valid agent with a free agent's tools and the metator commands of the contract", async () => {
    const fs = new InMemoryFileSystem({ [SOURCE]: text });
    const catalog = new AgentCatalog(fs, DEFAULT_PATHS);
    const report = (await new LintAgents(catalog, "mt-").execute())._unsafeUnwrap();
    expect(report.problems).toEqual([]);
    const agent = (await catalog.scan()).agents.find((a) => a.agent.id === "mt-chat")?.agent;
    expect(agent?.capabilities.filter((c) => !c.startsWith("metator:"))).toEqual([
      "read",
      "search",
      "edit",
      "execute",
      "agent",
      "todo",
      "web",
    ]);
    expect(agent ? metatorGroups(agent) : []).toEqual([
      "run",
      "workflow",
      "ask",
      "quick",
      "scratch",
      "session",
      "graph",
      "symbols",
      "cards",
      "similar",
      "rules",
      "system",
      "issue",
    ]);
    // Short: a prompt a person can read in a minute.
    expect(body.split("\n").length).toBeLessThanOrEqual(60);
  });

  test("it suggests the lightest way and the person decides; it never commits or pushes by itself", () => {
    expect(body).toContain("you pick the lightest way that fits and suggest it; the person decides");
    expect(body).toContain("You never commit, push, merge or rebase by yourself.");
    expect(body).toContain("Only when the person asks for it in their own words in this chat");
    expect(body).toContain("Lines that begin with `[metator]`");
    expect(body).toContain("never a consent");
  });

  test("the three ways, lightest first: direct, quick, full", () => {
    const [direct, quick, full] = ["## 1. Direct", "## 2. Quick", "## 3. Full"].map((h) => body.indexOf(h));
    expect(
      (direct as number) > 0 &&
        (direct as number) < (quick as number) &&
        (quick as number) < (full as number),
    ).toBe(true);
    // Direct: no question; code answers cite lines; a change not meant for a commit is recorded as scratch.
    const one = section("## 1. Direct");
    expect(one).toContain("ask nothing");
    expect(one).toContain("`path:line`");
    expect(one).toContain("`metator scratch begin`, make the edit, `metator scratch end --note");
    // Quick: checked first, suggested in these words, started only on yes; the override is the person's sentence.
    const two = section("## 2. Quick");
    expect(two).toContain("`metator quick check --task");
    expect(two).toContain('"This is too small for the full workflow: do it as quick?"');
    expect(two).toContain("`metator quick start --task");
    expect(two).toContain("dirty: pass --here or --worktree");
    expect(two).toContain('--override "<their sentence, word for word>"');
    expect(two).toContain("Never write that sentence yourself.");
    expect(two).toContain("A change that reaches another repository is never quick.");
    // Full: names the workflow, then `run new` and `run start`; the conductor has its own terminal.
    const three = section("## 3. Full");
    expect(three).toContain("Name the workflow that fits (`metator workflow list`)");
    expect(three.indexOf("`metator run new --workflow")).toBeLessThan(
      three.indexOf("`metator run start --run <id>`"),
    );
    expect(three).toContain("Never `metator run drive --detach` for a run you start here.");
  });

  test("it asks through the run once it has one, and steers sessions only with the person's words", () => {
    expect(body).toContain("in this chat while you have no run");
    expect(body).toContain('`metator run ask "<question>" --option <a> --option <b> --run <id> --wait`');
    expect(body).toContain("`metator session list --task <run>`");
    expect(body).toContain('`metator session tell <pane> --text "<their words>"`');
    expect(body).toContain('`metator session interrupt <pane> --text "<their words>"`');
    expect(body).toContain("Relay their words; add nothing of your own.");
    // The real chat once told the conductor what was meant for the worker: the prompt says how to pick.
    expect(body).toContain("is the row whose `role` is `worker`");
    expect(body).toContain("the `conductor` row only when they mean the run as a whole");
    expect(body).toContain("Never send a worker's message to the conductor.");
    expect(body).toContain("Say which session you told: its agent and pane.");
    expect(body).toContain(
      "say that the line waits until the agent is idle, and offer `metator session interrupt",
    );
  });

  test("both hosts have it, generated from the same source", () => {
    for (const file of [".claude/agents/mt-chat.md", ".github/agents/mt-chat.agent.md"]) {
      const host = read(file);
      expect(host).toContain(`generated by metator generate from ${SOURCE}`);
      expect(host).toContain("# Role");
      expect(host).toContain("do it as quick?");
    }
    // Claude Code: every tool of a free agent; Copilot CLI: the same capabilities.
    expect(read(".claude/agents/mt-chat.md")).toContain(
      "tools: Read, Glob, Grep, Edit, Write, Bash, Task, TodoWrite, WebFetch, WebSearch,",
    );
    expect(read(".github/agents/mt-chat.agent.md")).toContain(
      "tools:\n  - read\n  - search\n  - edit\n  - execute\n  - agent\n  - todo\n  - web\n",
    );
  });
});

/** The quick way's workflow and its one reviewer, as shipped (ADR-0093). */
describe("mt-quick: build, gate, the fit check, one short review, the card that ends it", () => {
  const spec = Bun.YAML.parse(read(".github/metator/workflows/mt-quick.yml")) as {
    stages: {
      id: string;
      owner: string;
      hitl?: boolean;
      gate?: { script: string };
      onFail?: { goto: string; loop: string };
    }[];
    loops: Record<string, number>;
    preconditions: string[];
  };

  test("no plan, no approval gate, no publish; the worker builds, a failed gate or a blocking finding goes back to build", () => {
    expect(spec.stages.map((s) => [s.id, s.owner])).toEqual([
      ["build", "mt-implementer"],
      ["gate", "script:metator gate quick --base HEAD"],
      ["fit", "script:metator quick check --diff"],
      ["review", "mt-quick-review"],
      ["ready", "script:metator run status"],
    ]);
    expect(spec.stages.some((s) => s.hitl)).toBe(false);
    expect(spec.stages.map((s) => s.gate?.script)).toEqual([
      undefined,
      undefined,
      "metator quick fit",
      "metator quick reviewed",
      "metator quick ready",
    ]);
    // The review sends it back once; a dirty checkout is the person's choice at the start, no precondition.
    expect([spec.stages[3]?.onFail, spec.loops, spec.preconditions]).toEqual([
      { goto: "build", loop: "review" },
      { build: 2, review: 1 },
      [],
    ]);
  });

  test("its reviewer reads the diff once, reports only what must be fixed, and never edits", async () => {
    const source = "metator/agents/mt-quick-review.md";
    const fs = new InMemoryFileSystem({ [source]: read(source) });
    const catalog = new AgentCatalog(fs, DEFAULT_PATHS);
    expect((await new LintAgents(catalog, "mt-").execute())._unsafeUnwrap().problems).toEqual([]);
    const agent = (await catalog.scan()).agents.find((a) => a.agent.id === "mt-quick-review")?.agent;
    expect([
      agent?.role,
      agent?.capabilities.includes("edit"),
      agent?.capabilities.includes("agent"),
    ]).toEqual(["worker", false, false]);
    const text = read(source);
    for (const words of [
      "`metator review diff`",
      "`BLOCKING: <n>`",
      "`No blocking finding.`",
      "One pass",
      "Never edit, create or delete a source file",
    ])
      expect(text).toContain(words);
  });
});
