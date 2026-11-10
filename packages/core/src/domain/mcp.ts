import { z } from "zod";
import { MetatorError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";
import { parseJsonDocument, serializeJsonDocument } from "./versioned.ts";

/**
 * An MCP server the agents may use (T1, design/14 §2, ADR-0083): started by command (stdio) or
 * reached by URL. `env` names the variables the server gets; a value is a literal or `${VAR}`,
 * never a token: the hosts resolve `${VAR}` from the environment, so the file stays committable.
 */
export const McpServerSchema = z
  .strictObject({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: z.string().url().optional(),
    env: z.record(z.string().min(1), z.string()).default({}),
  })
  .refine((s) => s.command !== undefined || s.url !== undefined, "an MCP server needs a command or a url");
export type McpServer = z.output<typeof McpServerSchema>;
export const McpServersSchema = z.record(z.string().min(1), McpServerSchema).default({});
export type McpServers = z.output<typeof McpServersSchema>;

/** The repository's servers with the person's layered over them by name. */
export function mergeMcpServers(repo: McpServers, user: McpServers): McpServers {
  return { ...repo, ...user };
}

/**
 * `.mcp.json` (read by Claude Code and Copilot CLI alike): the configured servers set by name
 * under `mcpServers`; entries nobody configured in MetatorAI are kept as they are. A server
 * removed from the configuration stays until a person removes it from the file.
 */
export function mcpJson(existing: string | undefined, servers: McpServers): Result<string, MetatorError> {
  let file: Record<string, unknown> = {};
  if (existing !== undefined) {
    // The hosts' file, not ours: read as plain JSON and kept as it is around `mcpServers`.
    const parsed = parseJsonDocument(existing, ".mcp.json");
    if (parsed.isErr()) return err(new MetatorError("INVALID_CONFIG", parsed.error.message));
    file = (parsed.value ?? {}) as Record<string, unknown>;
  }
  const theirs = (file.mcpServers as Record<string, unknown> | undefined) ?? {};
  const ours: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    ours[name] = {
      ...(s.command ? { command: s.command } : {}),
      ...(s.args.length > 0 ? { args: s.args } : {}),
      ...(s.url ? { url: s.url } : {}),
      ...(Object.keys(s.env).length > 0 ? { env: s.env } : {}),
    };
  }
  return ok(serializeJsonDocument({ ...file, mcpServers: { ...theirs, ...ours } }));
}
