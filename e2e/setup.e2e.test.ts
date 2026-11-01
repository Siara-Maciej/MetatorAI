/** `setup` and `agents install|update` end to end: real `metator` processes on real git repositories. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { inTerminal, KEY } from "./helpers/terminal.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const ROOT = join(import.meta.dir, "..");
const SCOUT = "metator/agents/mt-scout.md";
const GRILL = "metator/skills/mt-grill/SKILL.md";

interface Setup {
  gitignore: string;
  hosts: string[];
  workflows: string[];
  canon: { mode: string; steps: Record<string, number> };
  checks: { command: string; passed: boolean }[];
}
type Steps = { steps: { path: string; action: string }[] };
const actionOf = (data: unknown, path: string) => (data as Steps).steps.find((s) => s.path === path)?.action;

let repo: ScratchRepo;
/** A copy of the shipped canon that the tests change, as a newer MetatorAI version would. */
let newer: string;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(
    "package.json",
    JSON.stringify({ name: "shop", private: true, scripts: { test: "bun test" } }),
  );
  await repo.commit("init");
  newer = await mkdtemp(join(tmpdir(), "metator-canon-"));
  await cp(join(ROOT, "metator"), join(newer, "metator"), { recursive: true });
  await cp(join(ROOT, ".github/metator/workflows"), join(newer, ".github/metator/workflows"), {
    recursive: true,
  });
});
afterAll(async () => {
  await repo.dispose();
  await rm(newer, { recursive: true, force: true });
});

describe("metator setup (real CLI)", () => {
  test("one command: config with the chosen host, the canon, host files and green checks", async () => {
    const r = await metator(["setup", "--host", "claude", "--yes"], repo.root);
    const data = r.json.data as Setup;
    expect([r.code, data.hosts, data.canon.mode]).toEqual([0, ["claude"], "install"]);
    expect(data.workflows).toEqual([
      "mt-bugfix",
      "mt-feature",
      "mt-pr-review",
      "mt-refactor",
      "mt-self-review",
      "mt-system-change",
    ]);
    expect(data.checks.every((c) => c.passed)).toBe(true);
    expect(await repo.read("metator.config.yml")).toContain("targets:\n    - claude");
    expect([await repo.exists(".claude/agents/mt-scout.md"), await repo.exists(".github/agents")]).toEqual([
      true,
      false,
    ]);
    expect(await repo.read(SCOUT)).toBe(await Bun.file(join(ROOT, SCOUT)).text());
    const versioned = await findUnversioned(repo.root, [".github/metator"]);
    expect(versioned.unversioned).toEqual([]);
    expect(JSON.parse(await repo.read("metator/install.lock.json"))).toMatchObject({
      kind: "InstallLock",
      schemaVersion: 1,
    });
    // Local state (index, runs, worktrees) is ignored once, never committed.
    expect([data.gitignore, await repo.read(".gitignore")]).toEqual([
      "added",
      expect.stringContaining("\n.metator/\n"),
    ]);
    const again = (await metator(["setup", "--host", "claude", "--yes"], repo.root)).json.data as Setup;
    expect(again.gitignore).toBe("present");
  });

  test("a second install is refused; setup again updates and saves the hosts it was given", async () => {
    const again = await metator(["agents", "install"], repo.root);
    expect([again.code, (again.json.error as { code: string }).code]).toEqual([64, "USAGE"]);
    const r = await metator(["setup", "--host", "copilot", "--yes"], repo.root);
    expect([r.code, (r.json.data as Setup).canon.mode]).toEqual([0, "update"]);
    expect(await repo.read("metator.config.yml")).toMatch(/targets:\s*\n\s*- copilot\n/);
    expect(await Bun.file(join(repo.root, ".github/agents/mt-scout.agent.md")).exists()).toBe(true);
    // Back to Claude for the tests below.
    expect((await metator(["setup", "--host", "claude", "--yes"], repo.root)).code).toBe(0);
  });

  test("update takes a newer canon, keeps a local edit and reports a real conflict", async () => {
    await repo.write(GRILL, `${await repo.read(GRILL)}\nOur team asks one question at a time.\n`);
    await repo.write(SCOUT, `${await repo.read(SCOUT)}\nLocal note.\n`);
    await Bun.write(join(newer, SCOUT), `${await Bun.file(join(newer, SCOUT)).text()}\nUpstream note.\n`);
    const mtDiagnose = "metator/skills/mt-diagnose/SKILL.md";
    await Bun.write(
      join(newer, mtDiagnose),
      `${await Bun.file(join(newer, mtDiagnose)).text()}\nNew step.\n`,
    );
    const env = { METATOR_CANON: newer };

    const r = await metator(["agents", "update"], repo.root, env);
    expect([r.code, actionOf(r.json.data, SCOUT), actionOf(r.json.data, GRILL)]).toEqual([
      0,
      "conflict",
      "kept",
    ]);
    expect(actionOf(r.json.data, mtDiagnose)).toBe("update");
    expect(await repo.read(mtDiagnose)).toContain("New step.");
    expect(await repo.read(SCOUT)).toContain("Local note.");
    expect(
      (r.json.warnings as string[]).some((w) => w.startsWith(`${SCOUT}: changed here and in the canon`)),
    ).toBe(true);

    const theirs = await metator(["agents", "update", "--theirs"], repo.root, env);
    expect([actionOf(theirs.json.data, SCOUT), actionOf(theirs.json.data, GRILL)]).toEqual([
      "overwrite",
      "kept",
    ]);
    expect(await repo.read(SCOUT)).toContain("Upstream note.");
    expect(await repo.read(GRILL)).toContain("one question at a time");
    // The agents run from their host files: the update refreshed them too.
    expect((theirs.json.data as { generated: number }).generated).toBeGreaterThan(0);
    const hostFile = (await Bun.file(repo.path(".claude/agents/mt-scout.md")).exists())
      ? ".claude/agents/mt-scout.md"
      : ".github/agents/mt-scout.agent.md";
    expect(await repo.read(hostFile)).toContain("Upstream note.");
  });

  test("errors as values: unknown workflow, update before install", async () => {
    const unknown = await metator(["agents", "update", "--workflows", "mt-nope", "--dry-run"], repo.root);
    expect((unknown.json.error as { message: string }).message).toBe("unknown workflow(s): mt-nope");
    const bare = await ScratchRepo.create();
    try {
      const r = await metator(["agents", "update"], bare.root);
      expect([r.code, (r.json.error as { hint: string }).hint]).toEqual([
        64,
        "Run `metator agents install` first (it keeps files you already have).",
      ]);
    } finally {
      await bare.dispose();
    }
  });

  test("in a terminal it asks: hosts, workflows, hooks", async () => {
    const fresh = await ScratchRepo.create();
    try {
      await fresh.write("package.json", '{"name":"w","private":true}');
      const r = await inTerminal(["setup"], fresh.root, [
        { waitFor: "Which AI hosts", keys: `${KEY.space}${KEY.enter}` }, // Claude Code is first: drop it
        { waitFor: "Which workflows", keys: `${KEY.space}${KEY.enter}` }, // drop mt-bugfix
        { waitFor: "Install the hooks", keys: KEY.enter },
      ]);
      const data = r.json.data as Setup;
      expect([r.code, data.hosts, data.workflows.includes("mt-bugfix"), data.workflows.length]).toEqual([
        0,
        ["copilot"],
        false,
        5,
      ]);
      expect(r.screen).toContain("MetatorAI setup");
      expect(await fresh.exists(".github/agents/mt-scout.agent.md")).toBe(true);
    } finally {
      await fresh.dispose();
    }
  }, 60_000);

  test("cancelling the wizard writes nothing", async () => {
    const fresh = await ScratchRepo.create();
    try {
      const r = await inTerminal(["setup"], fresh.root, [{ waitFor: "Which AI hosts", keys: KEY.ctrlC }]);
      expect([r.code, (r.json.error as { message: string }).message]).toEqual([64, "setup cancelled"]);
      expect(await fresh.exists("metator.config.yml")).toBe(false);
      expect(await fresh.exists("metator")).toBe(false);
    } finally {
      await fresh.dispose();
    }
  });
});
