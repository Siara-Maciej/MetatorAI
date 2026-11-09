/**
 * `metator mcp` end to end (P8, ADR-0081): a real MCP client over stdio talks to the real server
 * process in a real repository: the tools are listed with their read-only annotations, a call
 * runs the command and returns MetatorAI's envelope, a failing command is flagged as an error,
 * and the server ends when the client goes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let repo: ScratchRepo;
let client: Client;
let transport: StdioClientTransport;
type Data = Record<string, unknown>;
const text = (r: unknown) =>
  JSON.parse(((r as { content: { type: string; text: string }[] }).content[0] as { text: string }).text) as {
    ok: boolean;
    data?: Data;
    error?: Data;
  };

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("src/a.ts", 'import { b } from "./b.ts";\nexport const a = b + 1;\n');
  await repo.write("src/b.ts", "export const b = 1;\n");
  await repo.commit("init");
  await metator(["index", "build"], repo.root);
  transport = new StdioClientTransport({
    command: "bun",
    args: [CLI_ENTRY, "mcp"],
    cwd: repo.root,
    env: { ...(process.env as Record<string, string>), METATOR_STATE_DIR: E2E_STATE_DIR },
    stderr: "pipe",
  });
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
}, 60_000);
afterAll(async () => {
  await client.close();
  await repo.dispose();
});

describe("metator mcp (real server over stdio)", () => {
  test("lists the reading commands as read-only tools, the same set `metator mcp --list` prints", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("metator_version");
    expect(names).toContain("metator_graph_dependents");
    expect(names).toContain("metator_run_status");
    expect(names).not.toContain("metator_run_advance");
    expect(names).not.toContain("metator_gate");
    const version = listed.tools.find((t) => t.name === "metator_version");
    expect(version?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const schema = (version?.inputSchema ?? {}) as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("args");
    const cli = (await metator(["mcp", "--list"], repo.root)).json.data as { tools: { name: string }[] };
    expect(cli.tools.map((t) => t.name)).toEqual(names);
  });

  test("a call runs the command in the repository and returns the envelope; a bad call is an error", async () => {
    const version = text(await client.callTool({ name: "metator_version", arguments: {} }));
    expect(version).toEqual({ ok: true, data: { name: "metator-ai", version: "0.0.0" } });
    const deps = await client.callTool({
      name: "metator_graph_dependents",
      arguments: { args: ["src/b.ts"] },
    });
    expect(deps.isError ?? false).toBe(false);
    const dependents = text(deps).data as { dependents?: unknown[]; files?: unknown[] };
    expect(JSON.stringify(dependents)).toContain("src/a.ts");
    const bad = await client.callTool({
      name: "metator_graph_deps",
      arguments: { args: ["--no-such-flag"] },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad).ok).toBe(false);
    const status = text(await client.callTool({ name: "metator_run_status", arguments: {} }));
    expect([status.ok, (status.error as Data | undefined)?.code]).toEqual([false, "NOT_FOUND"]);
  });
});
