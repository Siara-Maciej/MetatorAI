/** `setup` and `agents install|update` end to end: real `metator` processes on real git repositories. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, cp, mkdtemp, rm, symlink } from "node:fs/promises";
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
  hostsFrom: string;
  workflows: string[];
  canon: { mode: string; steps: Record<string, number> };
  checks: { command: string; passed: boolean }[];
}
type Steps = { steps: { path: string; action: string }[] };
const actionOf = (data: unknown, path: string) => (data as Steps).steps.find((s) => s.path === path)?.action;

/** A PATH with bun and git only, plus stand-ins for the named host commands: what the machine shows. */
async function pathWith(...commands: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-path-"));
  paths.push(dir);
  for (const tool of ["bun", "git"]) await symlink(Bun.which(tool) as string, join(dir, tool));
  for (const command of commands) {
    await Bun.write(join(dir, command), "#!/bin/sh\n");
    await chmod(join(dir, command), 0o755);
  }
  return dir;
}
const paths: string[] = [];

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
  await Promise.all(paths.map((p) => rm(p, { recursive: true, force: true })));
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
      "mt-review-response",
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

  test("nothing says which host: in a terminal it asks the hosts and the hooks, never the workflows", async () => {
    const fresh = await ScratchRepo.create();
    try {
      await fresh.write("package.json", '{"name":"w","private":true}');
      const r = await inTerminal(
        ["setup"],
        fresh.root,
        [
          { waitFor: "Which AI hosts", keys: `${KEY.space}${KEY.enter}` }, // Claude Code is first: drop it
          { waitFor: "Install the hooks", keys: KEY.enter },
        ],
        20_000,
        { PATH: await pathWith() },
      );
      const data = r.json.data as Setup;
      expect([r.code, data.hosts, data.hostsFrom, data.workflows.length]).toEqual([
        0,
        ["copilot"],
        "asked",
        7,
      ]);
      expect(r.screen).toContain("MetatorAI setup");
      expect(r.screen).not.toContain("Which workflows");
      expect(await fresh.exists(".github/agents/mt-scout.agent.md")).toBe(true);
    } finally {
      await fresh.dispose();
    }
  }, 60_000);

  test("the hosts come from what is there: the repository's folders, else the commands on the machine", async () => {
    const cases: [string, Record<string, string>, string[], string[], string][] = [
      ["a .claude folder", { ".claude/settings.json": "{}" }, [], ["claude"], "found"],
      ["only copilot on PATH", {}, ["copilot"], ["copilot"], "found"],
      [
        "Copilot's instructions, both commands",
        { ".github/copilot-instructions.md": "# x\n" },
        ["claude", "copilot"],
        ["copilot"],
        "found",
      ],
      ["nothing: every host", {}, [], ["copilot", "claude"], "default"],
      // The repository says one host, the machine has only the other: both, a question in a terminal.
      ["two ways", { "CLAUDE.md": "# x\n" }, ["copilot"], ["copilot", "claude"], "default"],
    ];
    for (const [name, files, commands, hosts, from] of cases) {
      const fresh = await ScratchRepo.create();
      try {
        await fresh.write("package.json", '{"name":"w","private":true}');
        for (const [path, content] of Object.entries(files)) await fresh.write(path, content);
        const r = await metator(["setup", "--yes"], fresh.root, { PATH: await pathWith(...commands) });
        const data = r.json.data as Setup;
        expect([name, r.code, data.hosts, data.hostsFrom]).toEqual([name, 0, hosts, from]);
      } finally {
        await fresh.dispose();
      }
    }
  }, 120_000);

  test("hosts that are found are not asked: the terminal says them and asks only the hooks", async () => {
    const fresh = await ScratchRepo.create();
    try {
      await fresh.write("package.json", '{"name":"w","private":true}');
      await fresh.write("CLAUDE.md", "# notes\n");
      const r = await inTerminal(
        ["setup"],
        fresh.root,
        [{ waitFor: "Install the hooks", keys: `y` }],
        20_000,
        { PATH: await pathWith() },
      );
      const data = r.json.data as Setup & { hooks: boolean };
      expect([r.code, data.hosts, data.hostsFrom, data.hooks]).toEqual([0, ["claude"], "found", true]);
      expect(r.screen).toContain("AI hosts: Claude Code");
      expect(r.screen).not.toContain("Which AI hosts");
    } finally {
      await fresh.dispose();
    }
  }, 60_000);

  test("after setup the repository's own documents are what memory and docs commands read, not the generated host files", async () => {
    const generated = (paths: string[]) => paths.filter((p) => p.startsWith(".claude/"));
    const dupes = (await metator(["memory", "dupes"], repo.root)).json.data as {
      groups: { occurrences: { file: string }[] }[];
    };
    expect(generated(dupes.groups.flatMap((g) => g.occurrences.map((o) => o.file)))).toEqual([]);
    const paths = async (...args: string[]) =>
      (
        (await metator(args, repo.root)).json.data as {
          documents?: { path: string }[];
          files?: { path: string }[];
        }
      )[args[0] === "docs" ? "documents" : "files"]?.map((d) => d.path) ?? [];
    expect(generated(await paths("docs", "inventory"))).toEqual([]);
    expect(generated(await paths("memory", "inventory"))).toEqual([]);
    expect(generated(await paths("docs", "inventory", "--generated")).length).toBeGreaterThan(20);
    expect(generated(await paths("memory", "inventory", "--generated")).length).toBeGreaterThan(20);
    const links = async (...extra: string[]) =>
      ((await metator(["docs", "links", ...extra], repo.root)).json.data as { documents: number }).documents;
    expect((await links("--generated")) - (await links())).toBeGreaterThan(20);
  }, 60_000);

  test("a reading command before setup leaves nothing for git to show: its local state is excluded in this clone", async () => {
    const fresh = await ScratchRepo.create();
    try {
      await fresh.write("src/a.ts", "export const a = 1;\n");
      await fresh.commit("init");
      expect((await metator(["graph", "cycles"], fresh.root)).code).toBe(0);
      expect(await fresh.exists(".metator/index/imports.json")).toBe(true);
      expect(await fresh.git("status", "--porcelain")).toBe("");
      expect(await fresh.exists(".gitignore")).toBe(false);
    } finally {
      await fresh.dispose();
    }
  });

  test("cancelling the wizard writes nothing", async () => {
    const fresh = await ScratchRepo.create();
    try {
      const r = await inTerminal(
        ["setup"],
        fresh.root,
        [{ waitFor: "Which AI hosts", keys: KEY.ctrlC }],
        20_000,
        { PATH: await pathWith() },
      );
      expect([r.code, (r.json.error as { message: string }).message]).toEqual([64, "setup cancelled"]);
      expect(await fresh.exists("metator.config.yml")).toBe(false);
      expect(await fresh.exists("metator")).toBe(false);
    } finally {
      await fresh.dispose();
    }
  });
});
