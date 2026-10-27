# API overview

MetatorAI is integrated through four stable surfaces. All of them are versioned and machine-readable, so agents, scripts and CI can depend on them.

| Surface | Who uses it | Contract |
|---|---|---|
| [CLI and envelope](./cli.md) | agents, scripts, CI | one JSON object per command; stable error codes and exit codes |
| [Hooks protocol](./hooks.md) | GitHub Copilot, Claude Code | JSON on stdin, a decision or context on stdout, never a blocking failure |
| [Documents and schemas](./documents.md) | everything that reads or writes MetatorAI files | `kind` + `schemaVersion`, frozen JSON Schemas, migrations on read |
| [Ports and plugins](./extending.md) | contributors adding tools | small TypeScript interfaces with contract test suites |

## Commands by area

Every command group, generated from the CLI. Select a command for its arguments, options and defaults in the [Command reference](./commands.md).

<CommandMap />
