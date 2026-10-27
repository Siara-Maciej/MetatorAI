import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentHostContract, collect } from "@metator/testing";
import { CopilotAgentHost, parseLine } from "../src/copilot-agent-host.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A stand-in `copilot` binary: records its argv and prints JSONL, then exits with `code`. */
async function fakeCopilot(
  lines: string[],
  code = 0,
): Promise<{ bin: string; argvFile: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "metator-copilot-"));
  dirs.push(dir);
  const argvFile = join(dir, "argv");
  const bin = join(dir, "copilot");
  const body = lines.map((l) => `printf '%s\\n' '${l}'`).join("\n");
  await writeFile(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvFile}\n${body}\necho "trouble" >&2\nexit ${code}\n`,
  );
  await chmod(bin, 0o755);
  return { bin, argvFile, dir };
}

const task = (cwd: string) => ({
  agent: "mt-planner",
  prompt: "Plan it",
  cwd,
  projectRoot: cwd,
  runDir: `${cwd}/.metator/runs/r`,
});

agentHostContract("CopilotAgentHost", async () => {
  const f = await fakeCopilot(['{"type":"assistant.message","data":{"content":"Planned"}}']);
  return { host: new CopilotAgentHost(f.bin), task: task(f.dir) };
});

describe("CopilotAgentHost", () => {
  test("prompt mode with the agent, the worktree, the run directory, JSON output and no git push", async () => {
    const f = await fakeCopilot([]);
    await collect(new CopilotAgentHost(f.bin), task(f.dir));
    const argv = (await Bun.file(f.argvFile).text()).trim().split("\n");
    for (const pair of [
      ["-p", "Plan it"],
      ["--agent", "mt-planner"],
      ["-C", f.dir],
      ["--add-dir", `${f.dir}/.metator/runs/r`],
      ["--output-format", "json"],
      ["--deny-tool", "shell(git push)"],
    ])
      expect(argv[argv.indexOf(pair[0] as string) + 1]).toBe(pair[1] as string);
    expect(argv).toContain("--session-id");
    expect(argv).toContain("--allow-all-tools");
  });

  test("a session to resume is passed with --resume and reported back", async () => {
    const f = await fakeCopilot([]);
    const events = await collect(new CopilotAgentHost(f.bin), { ...task(f.dir), resume: "abc" });
    const argv = (await Bun.file(f.argvFile).text()).trim().split("\n");
    expect([events[0], argv[argv.indexOf("--resume") + 1]]).toEqual([{ type: "session", id: "abc" }, "abc"]);
  });

  test("a non-zero exit is a failed result with stderr; a missing binary too", async () => {
    const f = await fakeCopilot([], 3);
    const events = await collect(new CopilotAgentHost(f.bin), task(f.dir));
    expect(events.at(-1)).toEqual({ type: "result", ok: false, text: `${f.bin} exited 3: trouble` });
    const missing = await collect(new CopilotAgentHost(join(f.dir, "nope")), task(f.dir));
    expect(missing.at(-1)).toMatchObject({ type: "result", ok: false });
  });

  test("JSONL lines are read tolerantly", () => {
    expect(
      parseLine('{"type":"tool.execution_start","data":{"toolName":"bash","arguments":{"command":"ls"}}}'),
    ).toEqual([{ type: "tool", name: "bash", summary: '{"command":"ls"}' }]);
    expect(parseLine('{"type":"assistant.message","data":{"content":"Done"}}')).toEqual([
      { type: "text", text: "Done" },
    ]);
    expect(parseLine('{"type":"user.message","data":{"content":"Plan it"}}')).toEqual([]);
    expect(parseLine("plain words")).toEqual([{ type: "text", text: "plain words" }]);
    expect(parseLine("")).toEqual([]);
  });
});
