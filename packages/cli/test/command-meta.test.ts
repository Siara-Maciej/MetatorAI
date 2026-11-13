import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnlyCommand } from "@metator/core";
import {
  checkCommands,
  commandsFor,
  everyCommand,
  folderCommands,
  meta,
  reads,
  renamedCommand,
} from "../src/command-meta.ts";
import { describeCommands, VERBS } from "../src/commands/meta.ts";
import { alwaysOptions, mcpTools, refusedOptions } from "../src/mcp.ts";
import { buildProgram } from "../src/program.ts";
import { run } from "../src/run.ts";

/**
 * The lists these commands were kept in before each command said of itself what it is
 * (`meta(cmd, {...})`): the MCP tools, the options a tool refuses or always passes, the commands
 * of a folder, what `meta check-all` runs, the commands of the overview. What is derived now must
 * be what was written then (with `run new` where the overview said `run init`).
 */
const BEFORE = {
  tools: [
    "version",
    "help",
    "changed",
    "graph affected",
    "graph callers",
    "graph diff",
    "graph deps",
    "graph dependents",
    "graph cycles",
    "graph path",
    "graph packages",
    "workspace list",
    "symbols find",
    "api diff",
    "owners",
    "system show",
    "system lint",
    "system impact",
    "system sources",
    "system plan list",
    "system plan show",
    "system plan lint",
    "system status",
    "arch analyze",
    "arch check",
    "arch plan list",
    "arch plan show",
    "arch plan lint",
    "arch plan status",
    "arch cycles",
    "arch declared",
    "rules lint",
    "rules pack",
    "rules show",
    "rules check",
    "rules coverage",
    "memory inventory",
    "memory budget",
    "memory validate",
    "memory check",
    "memory dupes",
    "memory matrix",
    "docs inventory",
    "docs links",
    "docs drift",
    "similar",
    "adr lint",
    "config show",
    "findings check-quote",
    "review metadata",
    "review diff",
    "review plan",
    "plan lint",
    "plan scope",
    "debug-tags check",
    "workflow list",
    "workflow lint",
    "workflow validate",
    "run messages",
    "run status",
    "run published",
    "run list",
    "run questions",
    "run brief",
    "run activity",
    "run workers",
    "policy list",
    "worktree conflicts",
    "worktree list",
    "env status",
    "repos list",
    "repos status",
    "ask list",
    "status",
    "doctor",
    "inbox",
    "report",
    "pane list",
    "pane read",
    "issue list",
    "issue show",
  ],
  refused: {
    "system lint": ["--fetch"],
    "system sources": ["--fetch"],
    "arch check": ["--sarif"],
    "memory validate": ["--fix"],
    "docs drift": ["--fix"],
    "review metadata": ["--out"],
    "review diff": ["--out"],
    "review plan": ["--out"],
    "worktree conflicts": ["--notify"],
    "plan scope": ["--out"],
    doctor: ["--gates"],
    report: ["--html"],
  } as Record<string, string[]>,
  always: { "run brief": ["--peek"], "plan scope": ["--dry-run"] } as Record<string, string[]>,
  folder: [
    "help",
    "version",
    "repos init",
    "repos list",
    "repos status",
    "system discover",
    "ui",
    "ask",
    "ask list",
    "status",
    "inbox",
    "report",
    "serve",
    "supervise",
  ],
  checkAll: [
    "rules lint",
    "rules adapters --check",
    "memory check",
    "cards build --check",
    "patterns scan --check",
    "adr lint",
    "memory dupes --check",
    "meta agents-lint",
    "meta skills-lint",
    "workflow validate",
    "workflow lint",
    "generate --check",
    "docs links",
    "docs drift",
    "system lint",
  ],
  verbs: [
    "setup",
    "init",
    "doctor",
    "agents update",
    "generate",
    "run",
    "run init",
    "run start",
    "run drive",
    "run status",
    "inbox",
    "run answer",
    "issue list",
    "intake scan",
    "mrs list",
    "issue start",
    "review changes",
    "review notes add",
    "open",
    "attach",
    "status",
    "ui",
    "ask",
    "graph affected",
    "graph dependents",
    "symbols find",
    "cards build",
    "owners",
    "gate",
    "rules check",
    "arch check",
    "review plan",
    "findings to-github",
    "workflow lint",
    "repos",
    "system",
    "serve",
    "supervise",
    "worktree",
    "env",
    "report",
  ],
};

async function invoke(...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const lines: string[] = [];
  const code = await run(argv, { out: (text) => lines.push(text) });
  return { code, json: JSON.parse(lines[0] as string) };
}

/** Queries an agent's host runs unasked (core) that are not MCP tools (they say no `reads`). */
const QUERIES_NOT_TOOLS: string[] = ["findings validate", "findings schema", "plan schema", "run schema"];

describe("what a command says of itself (meta)", () => {
  const program = buildProgram(() => {});

  test("the MCP tools, with the options refused and always passed, are the ones listed before", () => {
    expect(mcpTools(program).map((t) => t.command)).toEqual(BEFORE.tools);
    expect(refusedOptions(program)).toEqual(BEFORE.refused);
    expect(alwaysOptions(program)).toEqual(BEFORE.always);
  });

  test("the commands of a folder of repositories are the ones listed before", () => {
    // `metator ui` was one of them; the full-screen view is withdrawn (ADR-0086).
    expect(folderCommands(program).sort()).toEqual(BEFORE.folder.filter((c) => c !== "ui").sort());
  });

  test("meta check-all runs the checks listed before, in the tree's order", () => {
    const now = checkCommands(program).map((argv) => argv.join(" "));
    expect([...now].sort()).toEqual([...BEFORE.checkAll].sort());
    expect(now[0]).toBe("system lint");
  });

  test("the overview's commands are the ones that say they are a person's", () => {
    const persons = commandsFor(program, "person");
    const verbs = VERBS.flatMap((g) => g.commands.map(([name]) => name));
    expect([...persons].sort()).toEqual([...verbs].sort());
    expect(verbs).toEqual(
      BEFORE.verbs.filter((v) => v !== "ui").map((v) => (v === "run init" ? "run new" : v)),
    );
  });

  test("help --for: each audience's commands; every command belongs to one, an old spelling to none", async () => {
    const of = async (audience: string) =>
      ((await invoke("help", "--for", audience)).json.data as { commands: { name: string }[] }).commands.map(
        (c) => c.name,
      );
    const [person, agent, hook, ci] = [
      await of("person"),
      await of("agent"),
      await of("hook"),
      await of("ci"),
    ];
    expect(hook).toEqual([
      "guard pre-tool",
      "guard post-edit",
      "guard stop",
      "guard subagent-output",
      "guard session-start",
      "guard precompact",
    ]);
    expect(person).toContain("status");
    expect(person).toContain("repos");
    expect(agent).toContain("run advance");
    expect(agent).not.toContain("status");
    expect(ci).toContain("meta check-all");
    expect(ci).toContain("workflow lint"); // a person's command that check-all runs too
    const leaves = describeCommands(program).commands.map((c) => c.name);
    const somebody = new Set([...person, ...agent, ...hook, ...ci]);
    expect(leaves.filter((c) => !somebody.has(c))).toEqual([]);
    const old = everyCommand(program)
      .filter((c) => c.meta.renamedTo)
      .map((c) => c.name);
    expect(old.filter((c) => somebody.has(c))).toEqual([]);
    const bad = await invoke("help", "--for", "robots");
    expect([bad.code, (bad.json.error as { code: string }).code]).toEqual([64, "USAGE"]);
  });

  test("a group that reads makes each of its commands a reader; a command that says nothing is not one", () => {
    const fresh = buildProgram(() => {});
    const group = meta(fresh.command("zz"), { reads: true });
    const leaf = group.command("peek");
    const other = fresh.command("yy").command("poke");
    expect([reads(leaf), reads(other)]).toEqual([true, false]);
  });

  test("core's read-only metator queries and the commands tagged reads: the differences, named", () => {
    // An agent's host may run a query without asking (core: METATOR_QUERIES, through
    // readOnlyCommand); an MCP tool is a command that says it reads. Two lists, kept by two
    // packages: this names where they differ, so a change to either one is seen here.
    const tagged = new Set(mcpTools(program).map((t) => t.command));
    const leaves = describeCommands(program, { renamed: true }).commands.map((c) => c.name);
    const queries = leaves.filter((c) => readOnlyCommand(`metator ${c}`, ["."]));
    expect(queries.filter((c) => !tagged.has(c))).toEqual(QUERIES_NOT_TOOLS);
    expect(queries.filter((c) => tagged.has(c)).length).toBeGreaterThan(25);
    expect(queries.length).toBeLessThan(tagged.size);
  });
});

describe("a renamed command (renamedCommand)", () => {
  const program = buildProgram(() => {});
  const old = everyCommand(program).filter((c) => c.meta.renamedTo);

  test("the old spellings are exactly these, each pointing at the command it is now", () => {
    expect(old.map((c) => `${c.name} -> ${c.meta.renamedTo}`).sort()).toEqual([
      "docs claims-schema -> docs schema",
      "issue drop -> issue rm",
      "meta agents-schema -> meta schema agents",
      "meta skills-schema -> meta schema skills",
      "run attach -> run take",
      "run init -> run new",
      "system status -> system plan status",
    ]);
  });

  test("an old spelling is not in the help, and the new one is", () => {
    const listed = describeCommands(program).commands.map((c) => c.name);
    for (const c of old) expect([c.name, listed.includes(c.name)]).toEqual([c.name, false]);
    for (const now of ["system plan status", "docs schema", "meta schema", "run new", "run take", "issue rm"])
      expect([now, listed.includes(now)]).toEqual([now, true]);
    expect(describeCommands(program, { renamed: true }).commands.map((c) => c.name)).toContain("run init");
  });

  test("old and new take the same arguments and options", () => {
    const shape = (name: string) => {
      const cmd = everyCommand(program).find((c) => c.name === name)?.cmd;
      return [cmd?.registeredArguments.map((a) => a.name()), cmd?.options.map((o) => o.flags)];
    };
    for (const [before, now] of [
      ["system status", "system plan status"],
      ["docs claims-schema", "docs schema"],
      ["run init", "run new"],
      ["run attach", "run take"],
      ["issue drop", "issue rm"],
    ] as const)
      expect([before, shape(before)]).toEqual([before, shape(now)]);
    expect(shape("run new")[1]).toContain("--workflow <id>");
  });

  test("an old spelling still runs and answers what the new one answers", async () => {
    const before = await invoke("docs", "claims-schema");
    const now = await invoke("docs", "schema");
    expect([before.code, now.code]).toEqual([0, 0]);
    expect(before.json).toEqual(now.json);
    const agents = await invoke("meta", "agents-schema");
    const skills = await invoke("meta", "schema", "skills");
    expect(agents.json).toEqual((await invoke("meta", "schema", "agents")).json);
    expect((await invoke("meta", "skills-schema")).json).toEqual(skills.json);
    expect(agents.json).not.toEqual(skills.json);
    // Its own --help still answers, under its own words.
    const help = await invoke("run", "init", "--help");
    expect([help.code, (help.json.data as { name: string }).name]).toEqual([0, "run init"]);
  });

  test("a command registered through it runs under both names, the old one hidden", () => {
    let calls = 0;
    const fresh = buildProgram(() => {});
    const group = fresh.command("zz");
    renamedCommand({ parent: group, name: "wipe" }, { parent: group, name: "rm" }, (cmd) =>
      cmd.argument("<id>", "which").action(() => {
        calls++;
      }),
    );
    fresh.parse(["zz", "wipe", "a"], { from: "user" });
    fresh.parse(["zz", "rm", "a"], { from: "user" });
    expect(calls).toBe(2);
    expect(
      describeCommands(fresh)
        .commands.filter((c) => c.name.startsWith("zz "))
        .map((c) => c.name),
    ).toEqual(["zz rm"]);
    const tagged = everyCommand(fresh).filter((c) => c.name.startsWith("zz "));
    expect(tagged.map((c) => [c.name, c.meta.renamedTo, c.meta.renamedFrom])).toEqual([
      ["zz rm", undefined, "zz wipe"],
      ["zz wipe", "zz rm", undefined],
    ]);
  });
});

describe("what a person reads at a terminal (render)", () => {
  const dir = mkdtempSync(join(tmpdir(), "metator-render-"));
  const at = async (argv: string[], terminal: boolean) => {
    const out: string[] = [];
    const shown: string[] = [];
    const code = await run(
      ["-C", dir, ...argv],
      { out: (t) => out.push(t) },
      terminal ? { terminal: { raw: (t: string) => shown.push(t) } as never } : {},
    );
    return { code, stdout: out.join("\n"), stderr: shown.join("") };
  };

  test("status, inbox and doctor: text on stderr, and stdout the same JSON line as without a terminal", async () => {
    for (const [argv, said] of [
      [["status"], "0 need you · 0 working · 0 stopped · 0 services"],
      [["inbox"], "Nothing waits for you."],
      [["doctor"], "not ready for a run"],
    ] as const) {
      const piped = await at([...argv], false);
      const person = await at([...argv], true);
      expect([argv[0], person.stdout]).toEqual([argv[0], piped.stdout]);
      expect([argv[0], piped.stderr]).toEqual([argv[0], ""]);
      expect(person.stderr).toContain(said);
      expect(JSON.parse(person.stdout).ok).toBe(true);
    }
    expect((await at(["doctor"], true)).stderr).toMatch(/✗ workflows +no workflow here/);
  });

  test("--json at a terminal: the JSON line alone, before or after the command", async () => {
    const plain = await at(["status"], false);
    for (const argv of [
      ["--json", "status"],
      ["status", "--json"],
    ]) {
      const quiet = await at(argv, true);
      expect([argv.join(" "), quiet.code, quiet.stderr, quiet.stdout]).toEqual([
        argv.join(" "),
        0,
        "",
        plain.stdout,
      ]);
    }
    expect((await at(["--json"], true)).stderr).toBe("");
    expect((await at(["status", "--help", "--json"], true)).stderr).toBe("");
  });

  test("--help of a command and the list of commands read as text too", async () => {
    const help = await at(["run", "status", "--help"], true);
    expect(help.stderr).toStartWith("metator run status [options] [run]");
    expect(help.stderr).toContain("--run <id>  run id (default: latest)");
    expect(JSON.parse(help.stdout).data.name).toBe("run status");
    const list = await at(["help"], true);
    expect(list.stderr).toMatch(/ {2}metator version +Print the MetatorAI version\n/);
    const bare = await at([], true);
    expect(bare.stderr).toContain("Work on a task");
    expect((await at(["help", "--for", "hook"], true)).stderr).toContain("6 commands for hook");
  });

  test("an error and a command with nothing to render say nothing on stderr", async () => {
    const failed = await at(["run", "status", "--run", "nope"], true);
    expect([failed.code, failed.stderr]).toEqual([1, ""]);
    expect((await at(["version"], true)).stderr).toBe("");
  });
});
