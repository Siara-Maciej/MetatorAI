import {
  type CodeHost,
  err,
  type IntakeItem,
  type IntakeSource,
  type McpServer,
  type McpServers,
  MetatorError,
  ok,
  type Result,
} from "@metator/core";

/** Calls one tool of one MCP server and returns the text of its result. */
export interface McpToolCaller {
  call(
    server: McpServer,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result<string, MetatorError>>;
}

/** The tool that lists a source's items and its arguments; `source.tool` names another tool. */
export function listCall(source: IntakeSource): {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
} {
  if (source.kind === "github") {
    const [owner, repo] = (source.repo ?? "").split("/");
    return {
      tool: source.tool ?? "list_issues",
      args: {
        owner: owner ?? "",
        repo: repo ?? "",
        state: source.state,
        ...(source.labels.length > 0 ? { labels: source.labels } : {}),
      },
    };
  }
  if (source.kind === "gitlab")
    return {
      tool: source.tool ?? "list_issues",
      args: {
        project_id: source.repo ?? source.project ?? "",
        state: source.state === "open" ? "opened" : source.state,
        ...(source.labels.length > 0 ? { labels: source.labels } : {}),
      },
    };
  const clauses = [
    ...(source.project ? [`project = "${source.project}"`] : []),
    ...(source.type ? [`issuetype = "${source.type}"`] : []),
    ...source.labels.map((l) => `labels = "${l}"`),
    ...(source.state === "open" ? ["statusCategory != Done"] : [`status = "${source.state}"`]),
  ];
  return { tool: source.tool ?? "jira_search", args: { jql: clauses.join(" AND ") } };
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;

/** A server's JSON (an array, or an object holding `issues` or `items`) as items; what has no id or title is left out. */
export function itemsFromResult(payload: string): Result<IntakeItem[], MetatorError> {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch (e) {
    return err(
      new MetatorError("PARSE_FAILED", `the MCP server did not answer with JSON: ${(e as Error).message}`),
    );
  }
  const holder = raw as { issues?: unknown; items?: unknown };
  const list = Array.isArray(raw) ? raw : Array.isArray(holder?.issues) ? holder.issues : holder?.items;
  if (!Array.isArray(list))
    return err(new MetatorError("PARSE_FAILED", "the MCP server's answer holds no list of issues"));
  const items: IntakeItem[] = [];
  for (const entry of list as Record<string, unknown>[]) {
    if (entry === null || typeof entry !== "object") continue;
    // A pull request listed among GitHub issues is not a task of the backlog.
    if (entry.pull_request !== undefined) continue;
    const fields = (entry.fields ?? {}) as Record<string, unknown>;
    const ref = text(entry.key) ?? text(entry.number) ?? text(entry.iid) ?? text(entry.id);
    const title = text(entry.title) ?? text(entry.summary) ?? text(fields.summary);
    if (!ref || !title) continue;
    const labels = (
      Array.isArray(entry.labels) ? entry.labels : Array.isArray(fields.labels) ? fields.labels : []
    )
      .map((l) => (typeof l === "string" ? l : text((l as { name?: unknown })?.name)))
      .filter((l): l is string => typeof l === "string" && l.length > 0);
    const url = text(entry.html_url) ?? text(entry.web_url) ?? text(entry.url);
    items.push({
      ref,
      title,
      body: text(entry.body) ?? text(entry.description) ?? text(fields.description) ?? "",
      ...(url ? { url } : {}),
      labels,
    });
  }
  return ok(items);
}

/**
 * `CodeHost` over the MCP servers configured in MetatorAI (T2, design/14 §3). The server is the
 * one named by the source's `mcp`, or by its kind (`github`, `gitlab`, `jira`).
 */
export class McpCodeHost implements CodeHost {
  constructor(
    private readonly servers: () => Promise<Result<McpServers, MetatorError>>,
    private readonly caller: McpToolCaller,
  ) {}

  async listItems(source: IntakeSource): Promise<Result<readonly IntakeItem[], MetatorError>> {
    const servers = await this.servers();
    if (servers.isErr()) return err(servers.error);
    const name = source.mcp ?? source.kind;
    const server = servers.value[name];
    if (!server)
      return err(
        new MetatorError("NOT_FOUND", `no MCP server named ${name} is configured`, {
          hint: "Add it under `mcp:` in metator.config.yml or ~/.config/metator/options.yml.",
        }),
      );
    const { tool, args } = listCall(source);
    const answered = await this.caller.call(server, tool, args);
    if (answered.isErr()) return err(answered.error);
    return itemsFromResult(answered.value);
  }
}
