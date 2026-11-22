# Hooks and guardrails

Hooks are scripts your AI host runs around an agent's tool calls. MetatorAI uses them to enforce what a prompt cannot guarantee: no secrets, no destructive commands, no edits outside the plan, no commit or push without your consent. This page shows how to install them and what they block.

## Install the hooks

```bash
metator generate --hooks
```

This writes the hook configuration for both hosts:

- `.claude/settings.json` for Claude Code. Your other settings and your own hooks stay. The same file gets deny rules under `permissions.deny` for what cannot be taken back: reading files that may hold secrets, merging a pull (merge) request, `git push --force`, `git reset --hard` and `git clean -f`. Claude Code applies a deny rule before any hook, prompt or auto mode, so these hold even when a hook does not run. Your own deny rules stay first.
- `.github/hooks/metator.json` for Copilot.

Review the diff and commit it. The hooks call `metator`, so it must be on your `PATH` (see [Install](../guide/install.md)). If you run it another way, set that command in `hosts.metatorCommand` in `metator.config.yml` before you generate.

## Hold commands in a sandbox

A hook and a deny rule decide whether a command runs. They do not limit what the command can reach once it runs: `npm test` is an ordinary command, and the dependencies it starts can open `.env` or your SSH keys and send them anywhere. Only the operating system can stop that. Claude Code has a sandbox for its shell commands, and MetatorAI turns it on for the repository:

```bash
metator config set sandbox.enabled true --scope repo
metator generate --hooks
metator doctor            # the check `isolation` says whether this machine can hold it
```

`generate --hooks` then writes a `sandbox` block into `.claude/settings.json`: the sandbox is on and a command that fails in it is not retried outside. Your own keys in that block stay. What a sandboxed command, and everything it starts, can do:

| It can | It cannot |
|---|---|
| read the repository and most of the machine | read the files the deny rules name (`.env`, keys) or the paths in `sandbox.denyRead` (default `~/.ssh`, `~/.aws`, `~/.netrc`) |
| write inside the repository and in `sandbox.allowWrite` | write anywhere else |
| connect to the hosts in `sandbox.allowedDomains` | connect to any other host |

Set the lists the same way, with commas between values: `metator config set sandbox.allowedDomains "registry.npmjs.org, api.example.com" --scope repo`. A tool that cannot run inside a sandbox goes in `sandbox.excludedCommands` (for example `docker compose *`); it then runs outside.

What you need to know before you turn it on:

- Linux and WSL2 need the packages `bubblewrap` and `socat`; macOS needs nothing; native Windows has no sandbox. `metator doctor` says which case you are in.
- With `~/.ssh` unreadable, `git push` over SSH from a sandboxed command works only through an SSH agent. Take `~/.ssh` out of `sandbox.denyRead` if you push with a key file.
- The sandbox holds the shell commands of Claude Code. Its hooks, its MCP servers and its own file tools run outside it, and so does everything Copilot runs. The hooks and deny rules above still apply to those.

## What each hook does

| Host event | Command | Effect |
|---|---|---|
| SessionStart | `metator guard session-start` | puts the active run's status into the agent's context; warns when the import index is missing |
| PreToolUse | `metator guard pre-tool` | denies the tool calls listed below |
| PostToolUse | `metator guard post-edit` | reports rule violations of the edited file back to the agent |
| SubagentStop | `metator guard subagent-output` | checks that the run's JSON artifacts are valid documents |
| PreCompact | `metator guard precompact` | writes a checkpoint into the run's log before the host compacts the context |
| Stop | `metator guard stop` | an active run at a working stage must be advanced or escalated before the agent stops |
| UserPromptSubmit | `metator guard user-prompt` | your own message that asks for a commit, push, merge or rebase is your consent to it, once |

## What the pre-tool hook denies

Always, with or without a run:

| Category | Examples |
|---|---|
| Secrets | reading or writing `.env`, `.env.*` (except `.env.example` and `.env.sample`), `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc` |
| Commands that never run | `git push --force`, `git reset --hard`, `git clean -f`, rewriting history, `rm -r` of `/`, `~`, `.` or `*`: the list `guard.commands.never` in [the configuration](../reference/configuration.md#guard) |
| Commands that need your consent | `git commit`, `git push`, `git merge`, `git rebase`, `metator review approve` (`guard.commands.ask`): the agent's call becomes your host's approval prompt; a click there, or your word in the chat ("commit"), lets one through. In a run, the approved delivery is that consent ([Approvals and consent](../use/approvals.md#commit-and-push)) |
| A commit with debug changes | a `git commit` that would hold a change recorded with `metator scratch`: stopped with the files until you say "commit anyway" or remove them |
| Approving a plan | `metator arch plan approve` and `metator system plan approve`: those are yours to run |

Only while a run is active:

| Category | Examples |
|---|---|
| Edits outside the plan | a file not listed in the run's `plan-scope.json`, or outside the repository |
| A coordinator editing | `mt-orchestrator` or `mt-pr-review` editing a file (they delegate) |
| A pull request without approval | `gh pr create`, `gh pr merge` and GitHub MCP tools that write, before `metator run approve push` (approving `delivery` grants it) |
| Comment without approval | `gh pr comment`, `gh pr review` and MCP tools that comment, before `metator run approve comment` |
| Moving a driven run | `metator run advance`, `approve`, `stop` and the like from an agent that `metator run drive` started: the drive moves the run |

Without an active run, only the first table applies. MetatorAI does not restrict ordinary work outside a run.

The hook denies, or for a command that needs your consent hands the call to your host's approval prompt. When it has no objection it says nothing, and your host's own permission rules decide the call as usual.

## Try it

Pipe a tool call into the hook to see its answer:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force"}}' | metator guard pre-tool
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"`git push --force` never runs here (guard.commands.never: git push --force*): it can lose work or rewrite history. If the person wants it, they run it themselves."}}
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

MetatorAI can also serve its reading commands to agents as an MCP server: see [MCP server](../reference/mcp.md).
