import { ok } from "@metator/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Command } from "commander";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import type { CommandContext } from "../context.ts";
import { type McpTool, mcpTools, toolArgv } from "../mcp.ts";

/**
 * `metator mcp` (P8, ADR-0081): MetatorAI as an MCP server over stdio. Each reading command is a
 * tool; a call runs the command in this process (the same use cases as the terminal) and returns
 * its JSON envelope as text, flagged as an error when the envelope says so. Stdout belongs to the
 * protocol, so the command prints nothing of its own until the client has gone.
 */
export function registerMcpCommand(program: Command, ctx: CommandContext): void {
  program
    .command("mcp")
    .description(
      "Serve MetatorAI's reading commands as MCP tools over stdio (for IDEs, chats and other agents)",
    )
    .option("--list", "print the tools instead of serving", false)
    .action(
      ctx.action(async (opts: { list: boolean }) => {
        const tools = mcpTools(program);
        if (opts.list) return { result: ok({ tools }) };
        const root = (program.opts() as { root?: string }).root;
        const served = await serve(tools, (argv) => ctx.invoke(root ? ["--root", root, ...argv] : argv));
        return { result: ok(served) };
      }),
    );
}

export interface ServedReport {
  readonly tools: number;
  readonly calls: number;
}

/** Serves until the client closes the connection; the tools run through `invoke`. */
export async function serve(
  tools: readonly McpTool[],
  invoke: (
    argv: readonly string[],
  ) => Promise<{ readonly code: number; readonly envelope: Record<string, unknown> }>,
): Promise<ServedReport> {
  const server = new McpServer({ name: "metator", version: pkg.version });
  let calls = 0;
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: `metator ${tool.command}`,
        description: tool.description,
        inputSchema: {
          args: z.array(z.string()).optional().describe("options and arguments, as on the command line"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ args }) => {
        calls++;
        const r = await invoke(toolArgv(tool, args ?? []));
        return {
          content: [{ type: "text", text: JSON.stringify(r.envelope) }],
          isError: r.code !== 0,
        };
      },
    );
  }
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
  return { tools: tools.length, calls };
}
