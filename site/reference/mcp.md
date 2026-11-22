# MCP server

Agents in IDEs, chats and other tools can read MetatorAI's answers through the Model Context Protocol:

```bash
metator mcp            # serve over stdio; the host starts it
metator mcp --list     # print the tools it would serve
```

Each reading command is a tool named after its words, such as `metator_graph_affected` or `metator_run_status`. A tool takes the command's options and arguments in `args` and returns the same JSON the terminal prints.

Commands that write, run your scripts or move a run are not served. An option of a served command that writes a file, changes files, clones a repository, sends a message or runs your scripts (`--out`, `--sarif`, `--fix`, `--fetch`, `--notify`, `--html`, `--gates`) is refused with `USAGE`. `run brief` as a tool does not mark the run as read, and `plan scope` as a tool returns the scope without writing `plan-scope.json`.

A client configuration:

```json
{ "mcpServers": { "metator": { "command": "metator", "args": ["mcp"], "cwd": "/path/to/your/repo" } } }
```

The MCP servers MetatorAI itself reads (for intake and reviews) are a different thing: they are listed under `mcp:` in `metator.config.yml` ([Configuration](./configuration.md#mcp-servers)).
