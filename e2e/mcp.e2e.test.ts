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
    // The tools an agent reaches for most show a form: typed fields besides `args`.
    const dependents = listed.tools.find((t) => t.name === "metator_graph_dependents");
    const typed = (dependents?.inputSchema ?? {}) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(typed.properties ?? {}).sort()).toEqual(["args", "file", "transitive"]);
    expect(typed.required).toEqual(["file"]);
    const cli = (await metator(["mcp", "--list"], repo.root)).json.data as { tools: { name: string }[] };
    expect(cli.tools.map((t) => t.name)).toEqual(names);
  });

  test("a call runs the command in the repository and returns the envelope; a bad call is an error", async () => {
    const version = text(await client.callTool({ name: "metator_version", arguments: {} }));
    expect(version).toEqual({ ok: true, data: { name: "metator-ai", version: "0.0.0" } });
    const deps = await client.callTool({
      name: "metator_graph_dependents",
      arguments: { file: "src/b.ts" },
    });
    expect(deps.isError ?? false).toBe(false);
    const dependents = text(deps).data as { dependents?: unknown[]; files?: unknown[] };
    expect(JSON.stringify(dependents)).toContain("src/a.ts");
    const bad = await client.callTool({
      name: "metator_graph_cycles",
      arguments: { args: ["--no-such-flag"] },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad).ok).toBe(false);
    // A typed tool without its required field is refused by the schema, before any command runs.
    const missing = await client.callTool({ name: "metator_graph_deps", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("file");
    const status = text(await client.callTool({ name: "metator_run_status", arguments: {} }));
    expect([status.ok, (status.error as Data | undefined)?.code]).toEqual([false, "NOT_FOUND"]);
  });

  test("a reading tool writes nothing: an option that writes is refused by name and no file appears", async () => {
    const refused = async (name: string, args: string[]) => {
      const r = await client.callTool({ name, arguments: { args } });
      return [r.isError, text(r).error?.code, text(r).error?.message];
    };
    expect(await refused("metator_review_metadata", ["--base", "HEAD", "--out", "meta.json"])).toEqual([
      true,
      "USAGE",
      "the tool metator_review_metadata only reads: --out is refused",
    ]);
    expect(await refused("metator_review_diff", ["--base", "HEAD", "--out=change.patch"])).toEqual([
      true,
      "USAGE",
      "the tool metator_review_diff only reads: --out is refused",
    ]);
    expect(await refused("metator_arch_check", ["--sarif", "arch.sarif"])).toEqual([
      true,
      "USAGE",
      "the tool metator_arch_check only reads: --sarif is refused",
    ]);
    for (const file of ["meta.json", "change.patch", "arch.sarif"])
      expect([file, await Bun.file(repo.path(file)).exists()]).toEqual([file, false]);
    // The same tool without the option still answers.
    const metadata = await client.callTool({
      name: "metator_review_metadata",
      arguments: { args: ["--base", "HEAD"] },
    });
    expect(metadata.isError ?? false).toBe(false);
    const names = (await client.listTools()).tools.map((t) => t.name);
    // plan scope is a tool that computes the scope and never writes plan-scope.json.
    expect(names).toContain("metator_plan_scope");
    await repo.write(
      "plan.json",
      JSON.stringify({
        kind: "Plan",
        schemaVersion: 1,
        task: "t",
        scope: ["src/**"],
        steps: [{ id: "S1", action: "modify", path: "src/a.ts", intent: "edit" }],
      }),
    );
    const scope = await client.callTool({ name: "metator_plan_scope", arguments: { file: "plan.json" } });
    expect(scope.isError ?? false).toBe(false);
    expect(JSON.stringify(scope.content)).toContain("src/a.ts");
    const out = await client.callTool({
      name: "metator_plan_scope",
      arguments: { file: "plan.json", args: ["--out", "scope.json"] },
    });
    expect([out.isError, text(out).error?.code, text(out).error?.message]).toEqual([
      true,
      "USAGE",
      "the tool metator_plan_scope only reads: --out is refused",
    ]);
    for (const file of ["plan-scope.json", "scope.json"])
      expect([file, await Bun.file(repo.path(file)).exists()]).toEqual([file, false]);
  });
});
