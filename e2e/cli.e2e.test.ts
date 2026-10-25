/**
 * CLI e2e: the real binary in a separate process, run from a foreign working directory
 * (a scratch repo), checking the contract agents and hooks rely on: one JSON line on stdout,
 * nothing on stderr, documented exit codes, and a startup budget.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";

let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "metator-e2e-repo-"));
  await Bun.write(join(repo, "package.json"), JSON.stringify({ name: "scratch", private: true }));
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("metator CLI (process e2e)", () => {
  test("version: exit 0, single JSON line, empty stderr", async () => {
    const run = await metator(["version"], repo);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.json).toEqual({ ok: true, data: { name: "metator-ai", version: "0.0.0" } });
  });

  test("help lists every command with a summary", async () => {
    const run = await metator(["help"], repo);
    const commands = (run.json.data as { commands: { name: string; summary: string }[] }).commands;
    expect(commands.map((c) => c.name)).toEqual([
      "version",
      "help",
      "changed",
      "workflow list",
      "workflow validate",
      "workflow schema",
      "run init",
      "run advance",
      "run status",
      "run list",
    ]);
    for (const c of commands) expect(c.summary.length).toBeGreaterThan(5);
  });

  test("unknown command: exit 64 (usage), machine-readable error with a hint", async () => {
    const run = await metator(["definitely-not-a-command", "--flag"], repo);
    expect(run.code).toBe(64);
    expect(run.stderr).toBe("");
    expect(run.json).toMatchObject({ ok: false, error: { code: "USAGE" } });
    expect((run.json.error as { hint: string }).hint).toContain("metator help");
  });

  test("output is pure JSON: no ANSI colors, no banners", async () => {
    const run = await metator(["version"], repo);
    expect(run.stdout).not.toContain(String.fromCharCode(27)); // ESC starts ANSI color codes
    expect(run.stdout.trim().startsWith("{")).toBe(true);
  });

  test("starts within the CLI budget (warm runs, median < 1.5 s)", async () => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) times.push((await metator(["version"], repo)).ms);
    times.sort((a, b) => a - b);
    expect(times[2] as number).toBeLessThan(1500);
  }, 20_000);
});
