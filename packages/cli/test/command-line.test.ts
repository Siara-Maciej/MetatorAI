import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRunList } from "../src/render.ts";
import { run } from "../src/run.ts";

async function invoke(...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const lines: string[] = [];
  const code = await run(argv, { out: (text) => lines.push(text) });
  expect(lines).toHaveLength(1);
  return { code, json: JSON.parse(lines[0] as string) };
}
const errorOf = (r: { json: Record<string, unknown> }) =>
  r.json.error as { code: string; message: string; hint?: string };

describe("the command line a person types", () => {
  test("--version and -V are the version command", async () => {
    for (const flag of ["--version", "-V"]) {
      const { code, json } = await invoke(flag);
      expect([flag, code, json]).toEqual([
        flag,
        0,
        { ok: true, data: { name: "metator-ai", version: "0.0.0" } },
      ]);
    }
  });

  test("help <command...> is that command's help; a command that is not there is a usage error that says so", async () => {
    const { code, json } = await invoke("help", "run", "status");
    expect([code, (json.data as { name: string }).name]).toEqual([0, "run status"]);
    expect(json).toEqual((await invoke("run", "status", "--help")).json);
    expect(((await invoke("help", "graph")).json.data as { name: string }).name).toBe("graph");
    const missing = await invoke("help", "run", "stauts");
    expect([missing.code, errorOf(missing)]).toEqual([
      64,
      {
        code: "USAGE",
        message: "unknown command: metator run stauts",
        hint: "Did you mean `metator run status`? `metator run --help` lists its commands.",
      },
    ]);
    expect([(await invoke("help", "nosuch")).code, (await invoke("help")).code]).toEqual([64, 0]);
  });

  test("a word after a group that is none of its commands: did you mean, and the group's own help", async () => {
    // `run` runs on its own too: commander took the word for an argument and suggested nothing.
    const typo = await invoke("run", "stauts");
    expect([typo.code, errorOf(typo)]).toEqual([
      64,
      {
        code: "USAGE",
        message: "unknown command: metator run stauts",
        hint: "Did you mean `metator run status`? `metator run --help` lists its commands.",
      },
    ]);
    expect(errorOf(await invoke("run", "nosuch")).hint).toBe("`metator run --help` lists its commands.");
    expect(errorOf(await invoke("graph", "dependants")).hint).toContain("`metator graph dependents`");
    // A known command's wrong option: its own help, not the whole list.
    expect(errorOf(await invoke("run", "status", "--bogus")).hint).toBe(
      "Run `metator run status --help` for its options and arguments.",
    );
    // No command at all: the whole list, as before.
    expect(errorOf(await invoke("frobnicate")).hint).toContain("metator help");
  });

  test("-C <dir> that is not a directory is a usage error, never a raw ENOENT or a walk up from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-root-"));
    try {
      const missing = await invoke("-C", join(dir, "nope"), "status");
      expect([missing.code, errorOf(missing).code, errorOf(missing).message]).toEqual([
        64,
        "USAGE",
        `no such directory: ${join(dir, "nope")}`,
      ]);
      await Bun.write(join(dir, "file.txt"), "x");
      const file = await invoke("--root", join(dir, "file.txt"), "version");
      expect([file.code, errorOf(file).message]).toEqual([64, `not a directory: ${join(dir, "file.txt")}`]);
      expect((await invoke("-C", dir, "version")).code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run schema of a name every object has (toString) is a usage error, not a crash", async () => {
    for (const name of ["toString", "constructor", "hasOwnProperty"]) {
      const r = await invoke("run", "schema", name);
      expect([name, r.code, errorOf(r).code]).toEqual([name, 64, "USAGE"]);
    }
    expect((await invoke("run", "schema", "plan.json")).code).toBe(0);
  });
});

describe("serve on a port it cannot have", () => {
  test("a usage error with the way out (--port 0), not INTERNAL; nothing is written", async () => {
    const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const dir = await mkdtemp(join(tmpdir(), "metator-port-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    try {
      const r = await invoke("-C", dir, "serve", "--port", String(taken.port), "--supervise-ms", "0");
      expect([r.code, errorOf(r).code]).toEqual([64, "USAGE"]);
      expect(errorOf(r).message).toContain(`127.0.0.1:${taken.port}`);
      expect(errorOf(r).hint).toContain("`--port 0` takes a free one");
      expect(existsSync(join(dir, ".metator", "daemon.json"))).toBe(false);
    } finally {
      taken.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("run list as text", () => {
  test("one run a line, newest first as given; none says so", () => {
    expect(renderRunList([])).toBe("No runs.");
    expect(
      renderRunList([
        {
          runId: "20260102-fix-login",
          workflow: "mt-bugfix",
          stage: "build",
          status: "active",
          updatedAt: "2026-01-02T10:11:12.000Z",
        },
        {
          runId: "20260101-a",
          workflow: "demo",
          stage: "done",
          status: "done",
          updatedAt: "2026-01-01T09:00:00.000Z",
        },
      ]),
    ).toBe(
      [
        "20260102-fix-login  active at build  mt-bugfix  2026-01-02 10:11",
        "20260101-a          done at done     demo       2026-01-01 09:00",
      ].join("\n"),
    );
  });
});

describe("run commands in a repository", () => {
  const WORKFLOW =
    "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: plan\n    owner: mt-planner\n    produces: [plan.md]\n";
  let dir: string;
  const at = async (...argv: string[]) => {
    const lines: string[] = [];
    const code = await run(["-C", dir, ...argv], { out: (t) => lines.push(t) });
    expect(lines).toHaveLength(1);
    return { code, json: JSON.parse(lines[0] as string) as Record<string, unknown> };
  };
  const inRepo = (...args: string[]) =>
    Bun.spawnSync(
      ["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir },
    );

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "metator-runs-"));
    inRepo("init", "-q", "-b", "main");
    await Bun.write(join(dir, ".gitignore"), ".metator/\n");
    await Bun.write(join(dir, ".github/metator/workflows/demo.yml"), WORKFLOW);
    inRepo("add", "-A");
    inRepo("commit", "-q", "-m", "init");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("run new --parent that is no run id is a usage error before anything is written", async () => {
    const r = await at("run", "new", "--workflow", "demo", "--task", "child", "--parent", "BAD");
    expect([r.code, errorOf(r).code]).toEqual([64, "USAGE"]);
    expect(errorOf(r).hint).toContain("run list");
    expect(existsSync(join(dir, ".metator", "runs"))).toBe(false);
  });

  test("the run as a word after the command or as --run, for every command about one run", async () => {
    const start = async (task: string) =>
      ((await at("run", "new", "--workflow", "demo", "--task", task)).json.data as { runId: string }).runId;
    const a = await start("first");
    const b = await start("second");
    const runIdOf = (r: { json: Record<string, unknown> }) => (r.json.data as { runId?: string }).runId;
    expect([runIdOf(await at("run", "messages", a)), runIdOf(await at("run", "messages"))]).toEqual([a, b]);
    const handoff = await at("run", "handoff", a);
    expect([handoff.code, JSON.stringify(handoff.json).includes(a)]).toEqual([0, true]);
    expect((await at("run", "checkpoint", a)).code).toBe(0);
    const taken = await at("run", "take", a, "--by", "ola");
    expect([taken.code, JSON.stringify(taken.json).includes(a)]).toEqual([0, true]);
    expect((await at("run", "release", a)).code).toBe(0);
    for (const argv of [
      ["run", "advance", "pass", a, "--run", b],
      ["run", "approve", "plan", a, "--run", b, "--by", "ola"],
      ["run", "take", a, "--run", b, "--by", "ola"],
      ["run", "release", a, "--run", b],
      ["run", "messages", a, "--run", b],
      ["run", "checkpoint", a, "--run", b],
      ["run", "resume", a, "--run", b, "--by", "ola"],
      ["run", "write", "plan.md", a, "--run", b],
      ["run", "handoff", a, "--run", b],
    ]) {
      const two = await at(...argv);
      expect([argv.join(" "), two.code, errorOf(two).message]).toEqual([
        argv.join(" "),
        64,
        `two runs named: ${a} and --run ${b}`,
      ]);
    }
  });

  test("run list narrows by status, workflow and count; cut to the budget, it names its own options", async () => {
    const listed = (await at("run", "list")).json.data as { runId: string }[];
    expect(listed.length).toBeGreaterThan(0);
    expect(
      ((await at("run", "list", "--limit", "1")).json.data as { runId: string }[]).map((r) => r.runId),
    ).toEqual(listed.slice(0, 1).map((r) => r.runId));
    expect((await at("run", "list", "--workflow", "nope")).json.data).toEqual([]);
    expect((await at("run", "list", "--status", "done")).json.data).toEqual([]);
    expect(
      ((await at("run", "list", "--status", "active", "--workflow", "demo")).json.data as unknown[]).length,
    ).toBe(listed.length);
    expect((await at("run", "list", "--status", "finished")).code).toBe(64);
    // Many runs: the line is cut to 8 KiB and says how to narrow it, with run list's own options.
    const runs = join(dir, ".metator", "runs");
    const first = listed[0]?.runId as string;
    const state = await Bun.file(join(runs, first, "state.json")).text();
    for (let i = 0; i < 80; i++) {
      const id = `20260101-copy-${i}`;
      await Bun.write(join(runs, id, "state.json"), state.replaceAll(first, id));
    }
    const cut = (await at("run", "list")).json;
    expect([cut.truncated, cut.next]).toEqual([
      true,
      "Narrow it with --status <status>, --workflow <id> or --limit <n> (the n changed last).",
    ]);
    const ten = await at("run", "list", "--limit", "10");
    expect([ten.json.truncated, (ten.json.data as unknown[]).length]).toEqual([undefined, 10]);
  });
});
