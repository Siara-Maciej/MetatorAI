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
      "index build",
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
      "api snapshot",
      "api diff",
      "owners",
      "system show",
      "system lint",
      "system schema",
      "rules lint",
      "rules pack",
      "rules show",
      "rules adapters",
      "rules check",
      "rules coverage",
      "rules scaffold",
      "rules schema",
      "memory inventory",
      "memory budget",
      "memory validate",
      "memory check",
      "memory dupes",
      "memory matrix",
      "memory schema",
      "lessons add",
      "docs inventory",
      "docs links",
      "docs drift",
      "docs claims-schema",
      "cards build",
      "patterns scan",
      "patterns schema",
      "similar",
      "adr lint",
      "discover",
      "init",
      "config show",
      "config schema",
      "agents install",
      "agents update",
      "setup",
      "gate",
      "meta agents-lint",
      "meta audit",
      "meta check-all",
      "meta agents-schema",
      "meta skills-lint",
      "meta skills-schema",
      "generate",
      "findings validate",
      "findings check-quote",
      "findings merge",
      "findings verdict",
      "findings to-github",
      "findings schema",
      "review plan",
      "eval run",
      "eval score",
      "eval compare",
      "eval schema",
      "plan lint",
      "plan scope",
      "plan schema",
      "test affected",
      "coverage diff",
      "flaky check",
      "debug-tags check",
      "guard pre-tool",
      "guard post-edit",
      "guard stop",
      "guard subagent-output",
      "guard session-start",
      "guard precompact",
      "workflow list",
      "workflow lint",
      "workflow validate",
      "workflow schema",
      "run init",
      "run advance",
      "run approve",
      "run checkpoint",
      "run handoff",
      "run close",
      "run status",
      "run schema",
      "run list",
      "run continue",
      "run drive",
      "run stop",
      "run questions",
      "run answer",
      "run activity",
      "worktree new",
      "worktree list",
      "worktree rm",
      "worktree prune",
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
