# Hooks and guardrails

Hooks are scripts your AI host runs around an agent's tool calls. MetatorAI uses them to enforce what a prompt cannot guarantee: no secrets, no destructive commands, no edits outside the plan, no push without your approval. This page shows how to install them and what they block.

## Install the hooks

```bash
metator generate --hooks
```

This writes the hook configuration for both hosts:

- `.claude/settings.json` for Claude Code. Your other settings and your own hooks stay.
- `.github/hooks/metator.json` for Copilot.

Review the diff and commit it. The hooks call `metator`, so it must be on your `PATH` (see [Install](../guide/install.md)). If you run it another way, set that command in `hosts.metatorCommand` in `metator.config.yml` before you generate.

## What each hook does

| Host event | Command | Effect |
|---|---|---|
| SessionStart | `metator guard session-start` | puts the active run's status into the agent's context; warns when the import index is missing |
| PreToolUse | `metator guard pre-tool` | denies the tool calls listed below |
| PostToolUse | `metator guard post-edit` | reports rule violations of the edited file back to the agent |
| SubagentStop | `metator guard subagent-output` | checks that the run's JSON artifacts are valid documents |
| PreCompact | `metator guard precompact` | writes a checkpoint into the run's log before the host compacts the context |
| Stop | `metator guard stop` | an active run at a working stage must be advanced or escalated before the agent stops |

## What the pre-tool hook denies

Always, with or without a run:

| Category | Examples |
|---|---|
| Secrets | reading or writing `.env`, `.env.*` (except `.env.example` and `.env.sample`), `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc` |
| Destructive commands | `git push --force`, `git reset --hard`, `git clean -f`, `rm -r` of `/`, `~`, `.` or `*` |
| Approving a plan | `metator arch plan approve` and `metator system plan approve`: those are yours to run |

Only while a run is active:

| Category | Examples |
|---|---|
| Edits outside the plan | a file not listed in the run's `plan-scope.json`, or outside the repository |
| A coordinator editing | `mt-orchestrator` or `mt-pr-review` editing a file (they delegate) |
| Push without approval | `git push`, `gh pr create`, `gh pr merge` and GitHub MCP tools that write, before `metator run approve push` |
| Comment without approval | `gh pr comment`, `gh pr review` and MCP tools that comment, before `metator run approve comment` |
| Moving a driven run | `metator run advance`, `approve`, `stop` and the like from an agent that `metator run drive` started: the drive moves the run |

Without an active run, only the first table applies. MetatorAI does not restrict ordinary work outside a run.

The hook only ever denies. When it has no objection it says nothing, and your host's own permission rules decide the call as usual.

## Try it

Pipe a tool call into the hook to see its answer:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force"}}' | metator guard pre-tool
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"git push --force is blocked: it can lose work. Ask the user to run it."}}
```

```bash
echo '{"tool_name":"Read","tool_input":{"file_path":".env"}}' | metator guard pre-tool
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":".env may hold secrets; agents do not read or write it."}}
```

## When a hook itself fails

If a hook cannot run its check (a broken configuration, for example), it reports the error as a system message and makes no decision. The host's default applies. A broken hook therefore does not lock you out of your editor, and it also does not protect you until you fix it.

The payload format and the exact answers are in [Hooks protocol](../reference/hooks.md).

## MetatorAI as an MCP server

Agents in IDEs, chats and other tools can read MetatorAI's answers through the Model Context Protocol:

```bash
metator mcp            # serve over stdio; the host starts it
metator mcp --list     # print the tools it would serve
```

Each reading command is a tool named after its words, such as `metator_graph_affected` or `metator_run_status`. A tool takes the command's options and arguments in `args` and returns the same JSON the terminal prints. Commands that write, run your scripts or move a run are not served. An option of a served command that writes a file, changes files, clones a repository, sends a message or runs your scripts (`--out`, `--sarif`, `--fix`, `--fetch`, `--notify`, `--html`, `--gates`) is refused with `USAGE`. `run brief` as a tool does not mark the run as read, and `plan scope` as a tool returns the scope without writing `plan-scope.json`. A client configuration:

```json
{ "mcpServers": { "metator": { "command": "metator", "args": ["mcp"], "cwd": "/path/to/your/repo" } } }
```
