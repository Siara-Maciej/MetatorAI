/** Canonical agents → host files end to end: the real `metator` process on a real repository. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

/** `${NAME}`: a reference the host resolves at start (never a token in a test or a file). */
const envRef = (name: string) => `\${${name}}`;

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

describe("metator generate writes the MCP servers (T1)", () => {
  test("the repository's `mcp:` goes to .mcp.json by name; entries nobody configured stay; the person's own servers stay out of the committed file; doctor names the servers", async () => {
    // The person's own options file: a server of theirs, and their own command for `notes`.
    const configDir = await mkdtemp(join(tmpdir(), "metator-e2e-config-"));
    await writeFile(
      join(configDir, "options.yml"),
      'kind: UserOptions\nschemaVersion: 2\noptions: {}\nmcp:\n  private:\n    command: sh\n    args: ["-c", "echo mine"]\n  notes:\n    command: sh\n    args: ["-c", "echo my-notes"]\n',
    );
    const env = { METATOR_CONFIG_DIR: configDir };
    await repo.write(
      "metator.config.yml",
      `kind: MetatorConfig
schemaVersion: 9
hosts:
  metatorCommand: npx metator
mcp:
  jira:
    url: https://mcp.example.com/jira
  notes:
    command: sh
    args: ["-c", "echo mcp"]
    env:
      NOTES_TOKEN: "\${NOTES_TOKEN}"
`,
    );
    await repo.write(".mcp.json", JSON.stringify({ mcpServers: { theirs: { command: "x" } } }));
    const r = await metator(["generate"], repo.root, env);
    expect(data(r).written).toContain(".mcp.json");
    expect(JSON.parse(await repo.read(".mcp.json"))).toEqual({
      mcpServers: {
        theirs: { command: "x" },
        jira: { url: "https://mcp.example.com/jira" },
        notes: { command: "sh", args: ["-c", "echo mcp"], env: { NOTES_TOKEN: envRef("NOTES_TOKEN") } },
      },
    });
    expect(data(await metator(["generate", "--check"], repo.root, env)).stale).toEqual([]);
    // MetatorAI itself still uses the person's servers.
    const doctor = await metator(["doctor"], repo.root, env);
    const mcp = (data(doctor).checks as { id: string; status: string; message: string }[]).find(
      (c) => c.id === "mcp",
    );
    expect(mcp).toMatchObject({ status: "ok", message: "MCP servers configured: jira, notes, private" });
    await rm(configDir, { recursive: true, force: true });
    // The repository as the next tests expect it: the first config, no generated files yet.
    await repo.write(
      "metator.config.yml",
      "kind: MetatorConfig\nschemaVersion: 1\nhosts:\n  metatorCommand: npx metator\n  models:\n    fast:\n      copilot: fast-model\n",
    );
    for (const f of [".mcp.json", ".claude/agents/mt-checker.md", ".github/agents/mt-checker.agent.md"])
      await rm(repo.path(f), { force: true });
  });
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
    expect(claude).toContain(
      "tools: Read, Glob, Bash(npx metator gate:*), Bash(npx metator run status:*), Bash(npx metator run schema:*), Bash(npx metator run write:*)\n",
    );
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
