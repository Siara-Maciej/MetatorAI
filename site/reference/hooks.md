# Hooks protocol

The AI host runs `metator guard <event>` at fixed moments. The host writes a JSON payload to stdin; MetatorAI answers on stdout with a decision or extra context, or prints nothing. GitHub Copilot (VS Code) and Claude Code share this format. `metator generate --hooks` writes the configuration for both.

## Bindings

| Host event | Command | Timeout | Matcher |
|---|---|---|---|
| `SessionStart` | `metator guard session-start` | 10 s | |
| `PreToolUse` | `metator guard pre-tool` | 5 s | every tool |
| `PostToolUse` | `metator guard post-edit` | 30 s | file-editing tools (`Edit`, `Write`, `MultiEdit`, `apply_patch`, …) |
| `SubagentStop` | `metator guard subagent-output` | 10 s | |
| `PreCompact` | `metator guard precompact` | 10 s | |
| `Stop` | `metator guard stop` | 10 s | |

## Input (stdin)

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
| `tool_name` (or `toolName`) | which policy applies: shell, file edit, MCP write tool |
| `tool_input` (or `toolInput`) | paths (`file_path`, `path`, `notebook_path`, patches) and shell commands |
| `agent_type` (or `agentType`, `agent_name`) | whether the caller is a coordinator |
| `stop_hook_active` | a Stop hook that already blocked once lets the agent stop |

## Output (stdout)

**PreToolUse**: a permission decision.

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"packages/web/src/app.ts is outside plan-scope.json; update the plan (mt-planner) or ask the user."}}
```

**SessionStart and PostToolUse**: context for the model.

```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse",
 "additionalContext":"metator rules check found 1 problem(s) in the edited file(s); fix them before going on:\npackages/money/src/debug.ts:1 SHOP-CODE-001: No console.log in library code"}}
```

**Stop and SubagentStop**: keep the agent working, with what is missing.

```json
{"decision":"block","reason":"Run 20261026-mt-feature-… is at stage build (expects PASS, FAIL, ABORT). Finish the stage and `metator run advance pass|fail`, or `metator run advance abort --reason …` to escalate."}
```

**Nothing to say**: no output, exit code `0`.

## Failure behavior

A hook must never lock you out of your editor. When a guard itself fails (for example, an invalid config), it exits `0` and reports the problem as a system message:

```json
{"systemMessage":"metator guard pre-tool: <the error message>"}
```

## Decision order of `pre-tool`

1. Secrets: any path or shell argument matching `.env`, `.env.*` (not `.env.example` or `.env.sample`), `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc` → deny.
2. Destructive shell commands: `git push --force`, `git reset --hard`, `git clean -f`, `rm -r` of `/`, `~`, `.`, `..`, `*` → deny.
3. No active run → allow (free mode).
4. External actions without approval → deny:
   - `git push`, `gh pr create|merge` and GitHub MCP write tools need `push`;
   - `gh pr|issue comment|review` and MCP comment or review tools need `comment`.
5. File edits:
   - by a coordinator → deny;
   - outside the repository → deny;
   - outside `plan-scope.json` → deny;
   - run artifacts under `.metator/` → always allowed.
6. Otherwise → allow.

## Try a hook by hand

```bash
echo '{"tool_name":"Read","tool_input":{"file_path":".env"}}' | metator guard pre-tool
# {"hookSpecificOutput":{…,"permissionDecision":"deny","permissionDecisionReason":".env may hold secrets; agents do not read or write it."}}
```
