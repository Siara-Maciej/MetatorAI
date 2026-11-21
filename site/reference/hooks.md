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
| `UserPromptSubmit` | `metator guard user-prompt` | 5 s | reads your own message: words that ask for a guarded command (commit, push, merge, rebase) are your consent to it, once; in a run's session, the task's main chat is told that you spoke there. A line the daemon typed into the session itself (a relay, a nudge, a notice) reaches this hook like any prompt and is neither; your answer to a card, typed for you, is your word but no direct talk |

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

`pre-tool` prints a denial, or `ask` for a command that needs your consent (the host then shows its own approval prompt with the reason), or `allow`: for a command you consented to in words, and, with `guard.prompts: metator` (the default), for a call that needs no approval prompt, with why (`no approval needed: it only reads`). Any other call gets no answer, so the host's own permission prompts apply as usual.

```bash
echo '{"tool_name":"Read","tool_input":{"file_path":".env"}}' | metator guard pre-tool
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":".env may hold secrets; agents do not read or write it."}}
```

A command on `guard.commands.ask`:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"`git commit -m Add a` needs your consent: answer here, or say it in the chat (\"commit\")."}}
```

`user-prompt` prints context for the model when your message is a consent, and nothing otherwise:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"MetatorAI: the person's message is their consent to commit, once, within 10 minutes. Run the command now; nothing else is consented."}}
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
3. The guard's own commands. An agent that runs `metator guard …` itself, or writes under `.metator/consents/`, is denied: a consent is your own word.
4. Dangerous commands, from `guard.commands` in [the configuration](./configuration.md#guard):
   - on `never` (`git push --force`, `git reset --hard`, `git clean -f`, `rm -r` of `/`, `~`, `.`, `..` or `*`, and the rest of the list): denied;
   - on `ask` (`git commit`, `git push`, `git merge`, `git rebase`): a commit that would hold recorded debug changes asks with the files (the whole command line is read: `git add src/a.ts && git commit` in one call takes `src/a.ts`, as do `git add -A`, `commit -a` and paths named on the commit); a command the run's approval covers, or one you consented to in words, passes; in a session without a terminal it is denied with how to approve; otherwise the answer is `ask`.
5. Plan approvals. `metator arch plan approve` and `metator system plan approve` are denied: a person runs them.
6. No active run. Everything else is left to the host. The chat you talk in (a pane with no run of its own) counts as having none, also while a run works in the same checkout.
7. Actions outside the repository, until a person approves them with `metator run approve push` or `metator run approve comment`:
   - `git push`, `gh pr create`, `gh pr merge` and MCP tools that create branches, files or pull requests need `push`;
   - `gh pr comment`, `gh pr review`, `gh issue comment` and MCP comment or review tools need `comment`.
8. File edits:
   - by a coordinator that has no `edit` capability (`mt-orchestrator`, `mt-pr-review`): denied;
   - of a file outside the repository: denied;
   - of a file under `.metator/`: allowed, so agents can write run artifacts;
   - of a file that `plan-scope.json` does not list, when the run has one: denied.

9. What needs no approval prompt (`guard.prompts: metator`), for a call nothing above objected to: MetatorAI's own command, a command that only reads, an edit inside the repository, or one of the repository's own checks is answered `allow`; a MetatorAI command that is your decision (`metator run approve`, `metator config set`, …) is answered `ask`, by name. See [What runs without a prompt](./configuration.md#what-runs-without-a-prompt).

Rules 1 to 5 apply with or without a run.
