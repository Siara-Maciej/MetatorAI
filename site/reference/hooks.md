# Hooks protocol

The host runs `metator guard <event>` at fixed moments of a session. This page is the contract of those commands: what they read, what they answer and in which order `pre-tool` decides. To install the hooks and to see what they protect, read [Hooks and guardrails](../repo/hooks.md).

## Install

```bash
metator generate --hooks
```

This writes the hook configuration for each host: `.claude/settings.json` for Claude Code (your other settings and your own hooks stay) and `.github/hooks/metator.json` for GitHub Copilot in VS Code. The command in the configuration is `hosts.metatorCommand` followed by `guard <event>`.

## Events

| Host event | Command | Timeout | What it does |
|---|---|---|---|
| `SessionStart` | `metator guard session-start` | 10 s | gives the model the active run and tells it when the import index is missing |
| `PreToolUse` | `metator guard pre-tool` | 5 s | denies a tool call that breaks a rule below; runs for every tool |
| `PostToolUse` | `metator guard post-edit` | 30 s | checks the edited files against the rules and reports violations; runs for file-editing tools only |
| `SubagentStop` | `metator guard subagent-output` | 10 s | keeps a subagent working until the run's JSON artifacts match their schemas |
| `PreCompact` | `metator guard precompact` | 10 s | writes a checkpoint to the run's `log.md` before the context is compacted |
| `Stop` | `metator guard stop` | 10 s | keeps the agent working while the active run is at a stage it must finish |

## Input

The host writes a JSON payload to stdin. GitHub Copilot and Claude Code use the same format.

```json
{
  "tool_name": "Edit",
  "tool_input": { "file_path": "/repo/packages/billing/src/discount.ts" },
  "agent_type": "mt-implementer",
  "cwd": "/repo",
  "stop_hook_active": false
}
```

| Field | Used for |
|---|---|
| `tool_name` (or `toolName`) | which policy applies: shell, file edit, MCP tool |
| `tool_input` (or `toolInput`) | the paths (`file_path`, `path`, `notebook_path`, files named in a patch) and the shell command |
| `agent_type` (or `agentType`, `agent_name`) | whether the caller is a coordinator |
| `stop_hook_active` | a `Stop` hook that already made the agent continue once lets it stop |

An empty or unreadable payload is treated as an empty object.

## Output

A guard with nothing to say prints nothing. Every guard exits `0`.

`pre-tool` prints only a denial. A call it does not object to gets no answer, so the host's own permission prompts apply as usual.

```bash
echo '{"tool_name":"Read","tool_input":{"file_path":".env"}}' | metator guard pre-tool
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":".env may hold secrets; agents do not read or write it."}}
```

`session-start` and `post-edit` print context for the model:

```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"metator rules check found 1 problem(s) in the edited file(s); fix them before going on:\n<file>:<line> <rule id>: <message>"}}
```

`stop` and `subagent-output` keep the agent working and say what is missing:

```json
{"decision":"block","reason":"Run <id> is at stage build (expects PASS, FAIL, ABORT). Finish the stage and `metator run advance pass`, or `metator run advance fail --reason …` when it cannot pass (the run loops back or escalates to a person); `metator run advance abort --reason …` ends the run."}
```

`stop` lets the agent stop when there is no active run, when the run waits for a person's approval, or when `metator run drive` drives the session.

## When a guard fails

A hook never locks you out of your editor. When a guard itself fails, for example on an invalid `metator.config.yml`, it still exits `0` and reports the problem as a message to you. The host's own rules then decide.

```json
{"systemMessage":"metator guard pre-tool: <the error message>"}
```

## Decision order of pre-tool

The first rule that matches decides.

1. Secrets. A path or a shell argument that matches `.env`, `.env.*` (except `.env.example` and `.env.sample`), `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc` or `.netrc` is denied, for reading and for writing.
2. Run control. In a session that `metator run drive` started, or in a worker's pane, the agent may not move the run itself (`metator run advance`, `approve`, `answer`, `close` and the like). The one exception is `metator run approve ... --via chat` while a person is attached to the session.
3. Destructive commands. `git push --force` (also `--force-with-lease`), `git reset --hard`, `git clean -f`, and `rm -r` of `/`, `~`, `.`, `..` or `*` are denied.
4. Plan approvals. `metator arch plan approve` and `metator system plan approve` are denied: a person runs them.
5. No active run. Everything else is left to the host.
6. Actions outside the repository, until a person approves them with `metator run approve push` or `metator run approve comment`:
   - `git push`, `gh pr create`, `gh pr merge` and MCP tools that create branches, files or pull requests need `push`;
   - `gh pr comment`, `gh pr review`, `gh issue comment` and MCP comment or review tools need `comment`.
7. File edits:
   - by a coordinator: denied;
   - of a file outside the repository: denied;
   - of a file under `.metator/`: allowed, so agents can write run artifacts;
   - of a file that `plan-scope.json` does not list, when the run has one: denied.

Rules 1 to 4 apply with or without a run.
