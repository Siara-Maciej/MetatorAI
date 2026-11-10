import { err, type McpServer, MetatorError, ok, type Result } from "@metator/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpToolCaller } from "./mcp-code-host.ts";

/** `${VAR}` in a configured value, from the environment; an unset variable is an empty string. */
export function resolveEnv(
  values: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values))
    out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
  return out;
}

/** One connection per call, closed after it: a scan is rare and a server must not be left running. */
export class SdkToolCaller implements McpToolCaller {
  constructor(
    private readonly cwd: string,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly timeoutMs = 60_000,
  ) {}

  async call(
    server: McpServer,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result<string, MetatorError>> {
    const client = new Client({ name: "metator-intake", version: "1" });
    try {
      const inherited = Object.fromEntries(
        Object.entries(this.env).filter((e): e is [string, string] => typeof e[1] === "string"),
      );
      const transport = server.command
        ? new StdioClientTransport({
            command: server.command,
            args: [...server.args],
            cwd: this.cwd,
            env: { ...inherited, ...resolveEnv(server.env, this.env) },
            stderr: "ignore",
          })
        : new StreamableHTTPClientTransport(new URL(server.url as string));
      await client.connect(transport, { timeout: this.timeoutMs });
      const result = await client.callTool({ name: tool, arguments: { ...args } }, undefined, {
        timeout: this.timeoutMs,
      });
      const content = (result.content ?? []) as { type: string; text?: string }[];
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");
      if (result.isError === true)
        return err(new MetatorError("COMMAND_FAILED", `MCP tool ${tool} failed: ${text.slice(0, 300)}`));
      return ok(text);
    } catch (e) {
      return err(new MetatorError("COMMAND_FAILED", `MCP tool ${tool}: ${(e as Error).message}`));
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
