# Security

This page lists what MetatorAI enforces with code, what it records, and where your data goes. An instruction in a prompt can be ignored by a model. The controls here are commands and hooks that you can read and test.

## What is enforced

| Control | Enforced by | Applies |
|---|---|---|
| Files that may hold secrets (`.env`, `.env.*`, `*.pem`, `*.key`, SSH keys, `.npmrc`, `.netrc`) are never read or written by an agent | `metator guard pre-tool` | always |
| Commands on `guard.commands.never` never run (`git push --force`, `git reset --hard`, `git clean -f`, `rm -r` of a root, …) | `metator guard pre-tool` | always |
| Commands on `guard.commands.ask` (`git commit`, `git push`, `git merge`, `git rebase`, `metator review approve`) run only with the person's consent: a click on the host's prompt, their own words in the chat, or a run's approved delivery | `metator guard pre-tool` and `metator guard user-prompt` | always |
| Every merge of a pull (merge) request (`gh pr merge`, `glab mr merge`, the merge API, MCP merge tools) and every push straight to `main` or `master` waits for the person's consent ("merge", or a click); an approved push never covers one | `metator guard pre-tool`, and the Claude host in-process | always |
| The same commands on `guard.commands.never` are deny rules of both hosts: `permissions.deny` and `--disallowedTools` for Claude Code, `--deny-tool` for Copilot CLI; secret files are deny rules on Claude Code too | `metator generate --hooks` and the session MetatorAI starts | always |
| With `sandbox.enabled`, every session MetatorAI starts (Claude Code and Copilot CLI) and everything it runs cannot read secret files or `sandbox.denyRead`, write outside the repository and its own files, or reach a host that is not listed | the operating system (bubblewrap, sandbox-exec) through the sandbox runtime `srt` | sessions MetatorAI starts, when you turn it on; not a `claude` or `copilot` you start yourself |
| An agent cannot approve an architecture plan or a system plan | `metator guard pre-tool` | always |
| Edits stay inside the repository and inside the files the plan lists (`plan-scope.json`) | `metator guard pre-tool` | during a run |
| Coordinators delegate and do not edit files | `metator guard pre-tool` | during a run |
| Creating a pull request and commenting on one need the run's `push` or `comment` approval | `metator guard pre-tool` and `metator run approve` | during a run |
| An agent cannot stop while the run is at a stage it must finish | `metator guard stop` | during a run |
| Every JSON artifact an agent writes matches its schema | `metator guard subagent-output` | during a run |

The exact order of the decisions is in [Hooks protocol](./hooks.md#decision-order-of-pre-tool). `metator setup` installs the hooks; `metator generate --hooks` adds them later.

::: warning
The hooks protect a session only where they are installed. Without them, the controls marked `metator guard` do not apply, and the host's own permission prompts are all you have.
:::

A guard that fails on its own error exits `0` and shows you a message. It does not block your editor, and it does not deny the call.

## Approvals

A workflow marks the stages where a person decides. See [Approvals and consent](../use/approvals.md).

- A stage with `hitl: true` waits for `metator run approve <stage> --by <name>`.
- A stage with `skipAt` passes without a person at the listed autonomy levels. A stage with `neverSkip: true` waits at every level.
- `push` and `comment` are separate approvals: `metator run approve push --by <name>`. Approving `delivery` grants the push; no autonomy level skips a stage that grants one.
- Each loop has a limit in the workflow. When a run reaches it, the run ends as `escalated` and a person takes over. It does not retry forever.
- A yes to a run's approval said in a session's chat counts only while that person is attached to the session (`--via chat`).
- A consent to a commit or a push comes only from the person's own message, through the host's user-prompt hook, and holds for one command within `guard.consentMinutes`. Lines MetatorAI types and the agent's own words never count. See [Approvals and consent](../use/approvals.md#commit-and-push).

## Audit trail

Each run keeps its history in `.metator/runs/<id>/`:

| File | Contents |
|---|---|
| `state.json` | the current stage, loops used, approvals with who and when; written only by `metator run` |
| `log.md` | append-only: every transition, approval, checkpoint and the close |
| `activity.jsonl` | what the drive did: agent calls, questions, errors |
| `questions/` | every question, its options and the answer |
| `summary.json` | written at close: status, duration, events, approvals, artifacts |
| artifacts | the plan, its scope, findings and the verdict, each a versioned document |

`metator run status` prints the stage and the recent history. `metator report` sums cost, agent time, questions and waiting across runs.

## Agent permissions

Each agent definition lists its capabilities. `metator generate` turns them into the host's tool allowlist.

```yaml
# metator/agents/mt-scout.md (front matter)
capabilities: [read, search, edit, "metator:graph", "metator:workspace", "metator:cards", "metator:owners"]
```

A `metator:<group>` capability lets the agent run that command group and nothing else from the CLI. A coordinator may start only the workers it names, never a general-purpose agent with every tool.

An agent may run a shell command without asking only when every part of it reads: `grep`, `rg`, `find`, `ls`, `cat`, `git log`, `git diff` and the like, with no option that writes or executes, no redirection to a file, and paths inside its own directories. Anything else goes to a person.

`metator meta agents-lint` checks every delegation: the agent exists, its coordinator allows it, and there are no cycles.

## Text from outside

Issue text, review comments and the content of other repositories are data for a task. MetatorAI quotes them as the reporter's words and the agent instructions say to treat them as data. The hooks above do not depend on the model following that instruction.

## Review findings

- A blocking finding must carry a quote that exists in the code, a trigger and the path by which it is reached. `metator findings validate` checks the quote against the code.
- A second agent, `mt-verifier`, tries to refute each blocking finding. Only confirmed findings block.
- `metator eval run` scores the review on recorded cases. `metator eval compare` fails when a change to agents, skills or instructions makes the scores worse.

## Checks on the repository's knowledge

`metator meta check-all` runs these in one pass. Run it in CI ([Gates and CI](../repo/gates-ci.md)).

| What changes | Check |
|---|---|
| Rules | `metator rules lint`, `metator rules coverage --min-e1 <percent>`, generated instructions up to date |
| Agents and skills | `metator meta agents-lint`, `metator meta skills-lint`, `metator generate --check` |
| Workflows | `metator workflow validate`, `metator workflow lint` |
| Knowledge | `metator memory check`, `metator docs links`, `metator docs drift`, `metator cards build --check` |
| Decisions | `metator adr lint` |

## Where data goes

- MetatorAI runs on your machine or in your CI runner. Its state and its reports are files: run state under `.metator/` (git-ignored), everything else committed.
- The conversation with the model goes through your host (Claude Code or GitHub Copilot CLI). The host's data policy applies to it.
- MetatorAI reaches outside services only through what you configure: git remotes, the MCP servers under `mcp`, `gh` for a code-host source that names it, and your `notify.command`.
- The daemon listens on `127.0.0.1` only, by default ([Daemon HTTP API](./http.md)).
- Tokens do not belong in `metator.config.yml`. Write `${VAR}` in an MCP server's `env`; the host fills it from your environment.
