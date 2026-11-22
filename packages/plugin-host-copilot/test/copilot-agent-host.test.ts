import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, MetatorError, ok } from "@metator/core";
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
    ])
      expect(argv[argv.indexOf(pair[0] as string) + 1]).toBe(pair[1] as string);
    expect(argv).toContain("--session-id");
    expect(argv).toContain("--allow-all-tools");
    // The config's never-commands too (MetatorAI's defaults here), from the one list both hosts read.
    const denied = argv.filter((_, i) => argv[i - 1] === "--deny-tool");
    expect(denied).toContain("shell(git push --force)");
    expect(denied).toContain("shell(git reset --hard)");
    // Nobody can be asked in prompt mode: a push stays denied by the process, a commit is the hook's.
    expect(denied).toContain("shell(git push)");
    expect(denied).not.toContain("shell(git commit)");
  });

  test("the program starts through the launch: in the sandbox when the repository has one (ADR-0104)", async () => {
    const f = await fakeCopilot([]);
    const launched: { argv: readonly string[]; cwd: string }[] = [];
    // A launch that runs the program through `env`, as the sandbox runs it through `srt`.
    const host = new CopilotAgentHost(f.bin, undefined, (argv, cwd) => {
      launched.push({ argv, cwd });
      return ok({ argv: ["env", "METATOR_SANDBOX=1", ...argv], sandboxed: true });
    });
    const events = await collect(host, task(f.dir));
    expect(launched[0]?.argv[0]).toBe(f.bin);
    expect(launched[0]?.cwd).toBe(f.dir);
    expect((await Bun.file(f.argvFile).text()).split("\n")).toContain("Plan it");
    expect(events.at(-1)).toMatchObject({ type: "result", ok: true });
    const failing = new CopilotAgentHost(f.bin, undefined, () =>
      err(new MetatorError("COMMAND_FAILED", "no srt")),
    );
    expect((await collect(failing, task(f.dir))).at(-1)).toEqual({
      type: "result",
      ok: false,
      text: `cannot start ${f.bin}: no srt`,
    });
  });

  test("what runs is the launch's argv, not the program's own: the sandbox's launcher starts it", async () => {
    const f = await fakeCopilot(['{"type":"assistant.message","data":{"content":"Planned"}}']);
    // A stand-in for the sandbox's launcher: records the argv it was given, then runs what it wraps.
    const launcher = join(f.dir, "launcher");
    const launcherArgv = join(f.dir, "launcher-argv");
    await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" > ${launcherArgv}\nshift\nexec "$@"\n`);
    await chmod(launcher, 0o755);
    const given: (readonly string[])[] = [];
    const host = new CopilotAgentHost(f.bin, undefined, (argv) => {
      given.push(argv);
      return ok({ argv: [launcher, "--wrapped", ...argv], sandboxed: true });
    });
    const events = await collect(host, task(f.dir));
    expect(await Bun.file(launcherArgv).exists()).toBe(true);
    const ran = (await Bun.file(launcherArgv).text()).trim().split("\n");
    expect(ran).toEqual(["--wrapped", ...(given[0] ?? [])]);
    expect(ran[1]).toBe(f.bin);
    expect(events.at(-1)).toEqual({ type: "result", ok: true, text: "Planned" });
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
