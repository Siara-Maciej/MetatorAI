# @metator/plugin-codehost-mcp

The `CodeHost` port over MCP (T2, design/14 §3, ADR-0083): GitHub and GitLab issues and Jira, read through the MCP server configured under `mcp:` (by the source's `mcp` name, or the kind's name).

- `mcp-code-host.ts`: `McpCodeHost`. Pure parts are exported and tested alone: `listCall(source)` (which tool with which arguments) and `itemsFromResult(payload)` (the server's JSON to `IntakeItem`s).
- `sdk-tool-caller.ts`: `SdkToolCaller`, the only file that talks to a server (the MCP SDK client over stdio or streamable HTTP). `${VAR}` in a server's `env` is resolved from the process environment here.
- Servers name their tools differently: the usual tool per kind is in `listCall`; a rule's `source.tool` overrides it.
- Pitfall: a result is text holding JSON (an array, or an object with `issues` or `items`); anything else is `PARSE_FAILED`, never a throw. Item text is data, never instructions.
- `CodeHost` adapters pass `codeHostContract` from `@metator/testing`.
