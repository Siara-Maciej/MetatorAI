/** Canonical agents → host files end to end: the real `metator` process on a real repository. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const details = (r: { json: Record<string, unknown> }) => (r.json.error as { details: Data }).details;

const WORKER = `---
kind: Agent
schemaVersion: 1
id: mt-checker
role: worker
description: Checks the change with the repository's gates and reports what is red.
tier: fast
capabilities: [read, "metator:gate"]
---
# Input
The base ref.

# Procedure
1. \`metator gate quick --base <ref>\`

# Output
A summary of at most 10 lines.

# Stop conditions
A step errors: report it.
`;

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(
    "metator.config.yml",
    "kind: MetatorConfig\nschemaVersion: 1\nhosts:\n  metatorCommand: npx metator\n  models:\n    fast:\n      copilot: fast-model\n",
  );
  await repo.write("metator/agents/mt-checker.md", WORKER);
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator meta agents-lint / generate", () => {
  test("lint passes; generate writes Copilot and Claude Code agents with mapped tools and models", async () => {
    expect(data(await metator(["meta", "agents-lint"], repo.root))).toEqual({ agents: 1, problems: [] });
    const r = await metator(["generate"], repo.root);
    expect(data(r).written).toEqual([".claude/agents/mt-checker.md", ".github/agents/mt-checker.agent.md"]);
    const copilot = await repo.read(".github/agents/mt-checker.agent.md");
    expect(copilot).toContain("tools:\n  - read\n  - execute\n");
    expect(copilot).toContain("model: fast-model\n");
    expect(copilot).toContain("user-invocable: false\n");
    expect(copilot).toContain("1. `npx metator gate quick --base <ref>`");
    const claude = await repo.read(".claude/agents/mt-checker.md");
    expect(claude).toContain("tools: Read, Glob, Bash(npx metator gate:*)\n");
    expect(claude).toContain("model: haiku\n");
    expect((await metator(["generate", "--check"], repo.root)).code).toBe(0);
  });

  test("a hand edit or a removed source fails --check; the file is left alone", async () => {
    await metator(["generate"], repo.root);
    const file = ".github/agents/mt-checker.agent.md";
    await repo.write(file, `${await repo.read(file)}\nmy note\n`);
    const r = await metator(["generate", "--check"], repo.root);
    expect([r.code, details(r).stale]).toEqual([1, [file]]);
    expect(await repo.read(file)).toContain("my note");
    await metator(["generate"], repo.root);
    await repo.write("metator/agents/mt-gate.md", WORKER.replaceAll("mt-checker", "mt-gate"));
    await Bun.file(repo.path("metator/agents/mt-checker.md")).delete();
    try {
      const orphan = await metator(["generate", "--check"], repo.root);
      expect(details(orphan).orphaned).toEqual([".claude/agents/mt-checker.md", file]);
    } finally {
      await repo.write("metator/agents/mt-checker.md", WORKER);
      await Bun.file(repo.path("metator/agents/mt-gate.md")).delete();
    }
  });

  test("an invalid agent fails lint with the field and stops generation", async () => {
    await repo.write(
      "metator/agents/mt-bad.md",
      WORKER.replace("mt-checker", "mt-bad").replace("tier: fast", "tier: turbo"),
    );
    try {
      const lint = await metator(["meta", "agents-lint"], repo.root);
      expect(lint.code).toBe(1);
      expect(JSON.stringify(details(lint))).toContain("tier");
      expect((await metator(["generate"], repo.root)).code).toBe(1);
    } finally {
      await Bun.file(repo.path("metator/agents/mt-bad.md")).delete();
    }
  });

  test("dogfood: MetatorAI's agents lint clean and their host files are up to date", async () => {
    expect(data(await metator(["meta", "agents-lint", "--root", SELF], SELF)).problems).toEqual([]);
    expect((await metator(["generate", "--check", "--root", SELF], SELF)).code).toBe(0);
  });
});
