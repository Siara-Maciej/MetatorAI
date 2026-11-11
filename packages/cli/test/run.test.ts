import { describe, expect, test } from "bun:test";
import { nonNegativeInt } from "../src/options.ts";
import { run } from "../src/run.ts";

async function invoke(...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const lines: string[] = [];
  const code = await run(argv, { out: (text) => lines.push(text) });
  expect(lines).toHaveLength(1);
  return { code, json: JSON.parse(lines[0] as string) };
}

describe("metator CLI", () => {
  test("version returns the package version in an envelope", async () => {
    const { code, json } = await invoke("version");
    expect(code).toBe(0);
    expect(json).toEqual({ ok: true, data: { name: "metator-ai", version: "0.0.0" } });
  });

  test("no arguments defaults to help", async () => {
    const { code, json } = await invoke();
    expect(code).toBe(0);
    expect(JSON.stringify(json)).toContain('"name":"version"');
  });

  test("--help on a command describes that command and its options, not every command", async () => {
    const { code, json } = await invoke("run", "answer", "--help");
    expect(code).toBe(0);
    const data = json.data as { name: string; usage: string; options: { flags: string }[] };
    expect(data.name).toBe("run answer");
    expect(data.usage).toContain("metator run answer");
    expect(data.options.map((o) => o.flags)).toContain("--by <name>");
    expect(JSON.stringify(json)).not.toContain('"name":"version"');
    // A group lists its commands.
    const group = (await invoke("findings", "-h")).json.data as { commands: { name: string }[] };
    expect(group.commands.map((c) => c.name)).toContain("findings verdict");
  });

  test("--help after -C <dir> or --root <dir> is still that command's help", async () => {
    for (const root of [["-C", "/nowhere"], ["--root", "/nowhere"], ["--root=/nowhere"]]) {
      const { code, json } = await invoke(...root, "serve", "--help");
      expect([code, (json.data as { name: string }).name]).toEqual([0, "serve"]);
    }
    const nested = (await invoke("-C", "/nowhere", "run", "answer", "-h")).json.data as { name: string };
    expect(nested.name).toBe("run answer");
  });

  test("a bare command group is that group's help, not a usage error with every command", async () => {
    for (const group of ["repos", "worktree", "env", "system", "graph"]) {
      const { code, json } = await invoke(group);
      const data = json.data as { name: string; commands: { name: string }[] };
      expect([code, json.ok, data.name]).toEqual([0, true, group]);
      expect(data.commands.length).toBeGreaterThan(0);
      expect(data.commands.every((c) => c.name.startsWith(`${group} `))).toBe(true);
    }
    const nested = (await invoke("-C", "/nowhere", "system", "plan")).json.data as { name: string };
    expect(nested.name).toBe("system plan");
    // A wrong word after the group is still a usage error.
    expect((await invoke("repos", "bogus")).code).toBe(64);
    expect((await invoke("repos", "--bogus")).code).toBe(64);
  });

  test("unknown command is a usage error with a hint and exit code 64", async () => {
    const { code, json } = await invoke("frobnicate");
    expect(code).toBe(64);
    expect(json).toMatchObject({ ok: false, error: { code: "USAGE" } });
    const error = json.error as { message: string; hint: string };
    expect(error.message).toContain("frobnicate");
    expect(error.hint).toContain("metator help");
  });

  test("the binary prints one JSON line and exits with the envelope's code", async () => {
    const proc = Bun.spawn(["bun", `${import.meta.dir}/../src/main.ts`, "version"], { stdout: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(stdout).data.name).toBe("metator-ai");
  });
});

describe("option parsers", () => {
  test("nonNegativeInt takes 0 and whole numbers, nothing else", () => {
    expect([nonNegativeInt("0"), nonNegativeInt("4310")]).toEqual([0, 4310]);
    for (const bad of ["abc", "-1", "1.5", "", " "]) expect(() => nonNegativeInt(bad)).toThrow("0 or more");
  });
});

describe("metator CLI usage errors (fail before touching the repository)", () => {
  const usage = async (...argv: string[]) => {
    const { code, json } = await invoke(...argv);
    expect(code).toBe(64);
    expect(json).toMatchObject({ ok: false, error: { code: "USAGE" } });
    return (json.error as { message: string }).message;
  };

  test("approve without --by", async () => {
    expect(await usage("run", "advance", "approve")).toContain("--by");
  });

  test("approve with a blank --by", async () => {
    expect(await usage("run", "advance", "approve", "--by", "  ")).toContain("--by");
  });

  test("abort without --reason", async () => {
    expect(await usage("run", "advance", "abort")).toContain("--reason");
  });

  test("unknown event", async () => {
    const message = await usage("run", "advance", "skip");
    expect(message).toContain("'skip'");
    expect(message).toContain("Allowed choices are pass, fail, approve, abort");
  });

  test("invalid autonomy level", async () => {
    const message = await usage("run", "init", "--workflow", "w", "--task", "t", "--autonomy", "L9");
    expect(message).toContain("'L9'");
    expect(message).toContain("Allowed choices are L0, L1, L2");
  });

  test("blank task", async () => {
    expect(await usage("run", "init", "--workflow", "w", "--task", "   ")).toContain("--task");
  });

  test("missing required option", async () => {
    expect(await usage("run", "init", "--task", "t")).toContain("--workflow");
  });

  test("a number that is not one", async () => {
    expect(await usage("review", "notes", "add", "x", "--by", "m", "--line", "abc")).toContain("--line");
    expect(await usage("open", "--file", "a.ts", "--line", "0")).toContain("--line");
    expect(await usage("run", "board", "--timeline", "many")).toContain("--timeline");
    for (const option of ["--port", "--supervise-ms", "--intake-ms", "--reviews-ms"]) {
      expect(await usage("serve", option, "abc")).toContain(option);
      expect(await usage("serve", option, "-1")).toContain(option);
      expect(await usage("serve", option, "1.5")).toContain(option);
    }
  });

  test("issue decide without a decision, or with both", async () => {
    expect(await usage("issue", "decide", "i001", "--by", "m")).toContain("--add or --drop");
    const both = await usage("issue", "decide", "i001", "--add", "--drop", "--by", "m");
    expect(both).toContain("cannot be used with");
  });

  test("a value outside an option's choices", async () => {
    expect(await usage("pane", "split", "w1:p1", "--dir", "up")).toContain("Allowed choices are right, down");
    expect(await usage("run", "result", "--worker", "w", "--status", "finished", "--summary", "s")).toContain(
      "Allowed choices are done, blocked, failed",
    );
    expect(await usage("run", "result", "--worker", "w", "--summary", "s")).toContain("--status");
  });

  test("unknown option", async () => {
    expect(await usage("run", "status", "--bogus")).toContain("--bogus");
  });
});
