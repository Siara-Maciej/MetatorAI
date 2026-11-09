# Hooks and guardrails

**Goal:** the important rules (scope, approvals, secrets) are enforced by a script the host runs, not by a prompt the model may ignore.

## Install the hooks

```bash
metator generate --hooks
```

This writes the hook configuration for both hosts:

- `.claude/settings.json`: merged, your own settings are kept;
- `.github/hooks/metator.json`: for Copilot.

Review the diff and commit it. Hooks call `metator` on your `PATH` (see [Installation](../guide/installation.md)), or the command in `hosts.metatorCommand`.

## What each hook does

| Host event | Command | What it enforces |
|---|---|---|
| SessionStart | `metator guard session-start` | puts the active run's status into context; warns when the import index is missing |
| PreToolUse | `metator guard pre-tool` | denies secrets, destructive commands, edits outside `plan-scope.json`, code edits by coordinators, push or comment without approval |
| PostToolUse | `metator guard post-edit` | reports rule violations of the edited file back to the agent |
| SubagentStop | `metator guard subagent-output` | every JSON artifact of the run must be a valid document |
| PreCompact | `metator guard precompact` | writes a checkpoint into the run log before the context is compacted |
| Stop | `metator guard stop` | an active run at a working stage must be advanced or escalated before the agent stops (not in a session `metator run drive` started: the drive moves the run) |

## What `pre-tool` denies

| Category | Examples |
|---|---|
| Secrets | `.env`, `.env.*` (not `.env.example`), `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc` |
| Destructive commands | `git push --force`, `git reset --hard`, `git clean -f`, `rm -r` of `/`, `~`, `.` or `*` |
| Outside the plan (during a run) | an edit to a file not listed in the active run's `plan-scope.json`, or outside the repository |
| Coordinators editing (during a run) | `mt-orchestrator` or `mt-pr-review` editing code (they delegate) |
| External actions (during a run) | `git push`, `gh pr create`, `gh pr comment`, GitHub MCP write tools, without `metator run approve push` or `comment` |
| Moving a driven run | `metator run advance`, `approve`, `answer`, `stop`, `close`, `resume` from an agent `metator run drive` started: the drive moves the run when the stage's work is done |

The guard only ever denies. A call it does not object to gets no answer, so your host's own permission rules decide it as usual; an `allow` from a hook would skip them.

Secrets and destructive commands are blocked always. The other checks apply while a run is active: approvals, scope and roles belong to a run. Without an active run, MetatorAI does not stand in your way (free mode).

## Try it

With an active run (`metator run init --workflow mt-feature --task "..."`):

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | metator guard pre-tool
# {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
#  "permissionDecisionReason":"push needs the user's approval: ... `metator run approve push --by <user>`."}}

metator run approve push --by alice
echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | metator guard pre-tool
# (no output: nothing to object to, your host's permissions decide)
```

**Why hooks fail open on their own errors:** a broken hook must not lock you out of your editor. Errors are reported as a system message, and the decision falls back to the host's default.

## MetatorAI as an MCP server

Agents in IDEs, chats and other tools reach MetatorAI's answers through the Model Context Protocol:

```bash
metator mcp            # serves over stdio; the host starts it
metator mcp --list     # the tools it would serve
```

Every reading command is a tool named by its words (`metator_graph_affected`, `metator_run_status`), with `args`, the command's own options and arguments as on the command line (the most used tools, such as `metator_graph_dependents` or `metator_run_status`, also take typed fields: `file`, `transitive`, `run`); the result is the same JSON envelope the terminal prints, flagged as an error when the envelope says so. Nothing that writes, runs your scripts, drives a run, answers a person's question or talks to an AI host is a tool: those stay with the person and the run's hooks. A client configuration, for a host that takes one:

```json
{ "mcpServers": { "metator": { "command": "metator", "args": ["mcp"], "cwd": "/path/to/your/repo" } } }
```
