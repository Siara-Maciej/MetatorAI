# Copilot and Claude Code

MetatorAI runs its agents through Claude Code or GitHub Copilot CLI. This page shows which files each tool gets, how to choose the tools for a repository, which one the app starts, and how agents are limited to the commands they need. These docs call the AI tool the host.

The daemon starts the host's command-line program in a terminal: `claude` for Claude Code, `copilot` for GitHub Copilot CLI. Install it and log in once in a terminal of your own. Copilot Chat in an IDE reads the same generated agents, but the app's chats and runs need the CLI.

## One source, generated files

You edit agents and skills in one place, `metator/`. `metator generate` writes the files each host reads.

| Source | Claude Code | GitHub Copilot |
|---|---|---|
| `metator/agents/<id>.md` | `.claude/agents/<id>.md` | `.github/agents/<id>.agent.md` |
| `metator/skills/<name>/` | `.claude/skills/<name>/` | `.github/skills/<name>/` |
| hooks | `.claude/settings.json` | `.github/hooks/metator.json` |

Both hosts get the same agents with the same instructions, and both call the same `metator guard` commands from their hooks.

::: warning Do not edit generated files
A change made in `.claude/agents/`, `.github/agents/` or the generated skills is overwritten by the next `metator generate`. Edit the source under `metator/` instead.
:::

## Choose the hosts

`hosts.targets` in `metator.config.yml` lists the hosts that get files. Without it, both do. The first `metator setup` writes it from what it finds: the hosts the repository already has files for, or else the hosts whose command is on your machine ([Start with one repository](./first-run.md#set-up-the-repository)).

```yaml
hosts:
  targets:
    - copilot
    - claude
```

Change it with setup, which keeps the rest of your config:

```bash
metator setup --host copilot claude --yes
```

## Regenerate and check

```bash
metator generate            # write the host files from metator/
metator generate --hooks    # also write the hook configuration
metator generate --check    # compare only
```

`generate --check` fails when a generated file was edited by hand or is out of date:

```json
{"ok":false,"error":{"code":"CHECK_FAILED","message":"1 stale generated file(s)",
 "hint":"Run `metator generate` and commit the result; never edit generated host files."}}
```

Run it in CI so the committed host files always match their source.

## What an agent may use

Each agent declares `capabilities`. The generator turns them into the host's tool list. On Claude Code a capability such as `metator:graph` becomes `Bash(metator graph:*)`, so the agent can run that command group and no other shell command. This is the scout, which maps what a task touches:

```yaml
# metator/agents/mt-scout.md
capabilities: [read, search, edit, "metator:graph", "metator:workspace", "metator:cards", "metator:owners"]
```

```text
# generated .claude/agents/mt-scout.md
tools: Read, Glob, Grep, Edit, Write, Bash(metator graph:*), Bash(metator workspace:*), Bash(metator cards:*), Bash(metator owners:*), Bash(metator run status:*), Bash(metator run schema:*), Bash(metator run write:*)
```

The hooks apply on top of the tool list. The host calls `metator guard pre-tool` before every tool use and `metator guard post-edit` after every edit. An agent cannot skip a hook, because the host runs it, not the model. See [Hooks and guardrails](../repo/hooks.md).

## Models

Each agent has a tier: `reasoning`, `standard` or `fast`. For Claude Code the tiers map to `opus`, `sonnet` and `haiku`. Override a tier per host in the config, then run `metator generate`:

```yaml
hosts:
  models:
    fast:
      claude: sonnet
```

## Which host runs what

| What | Host |
|---|---|
| A chat in the app, and a run's conductor and workers | the first host of `supervisor.hostOrder` that is installed on the daemon's machine; the default order is `copilot`, `claude`, `opencode` |
| A run started from the **Form…** | the host you choose there; one that is not installed is greyed out |
| A step of a system plan | the system run's host when it is installed, else the first of `supervisor.hostOrder` |
| `metator run drive` (no terminal of its own) | `--host`, else the first entry of `hosts.targets` |

The daemon looks the hosts up each time, so a host you install while it runs is found without a restart. **Settings › System › Daemon** lists each host as **installed** or **not installed**. Change the order for a repository:

```bash
metator config set supervisor.hostOrder claude,copilot --scope repo
```

The daemon reads it when it starts: restart `metator serve` after you change it.

OpenCode (`opencode`) can run a session too, but `metator generate` writes files for Claude Code and Copilot only, and the [conformance suite](./conformance.md) does not expect it to pass.

Outside the app, in the host's own chat, the same agents are there: `mt-chat` is the conversation that suggests a way and starts runs, and `mt-orchestrator` is the conductor that carries one run stage by stage.

## Related

- [Host conformance](./conformance.md): the same checks against each host's real CLI, and the parity gaps between them.
- [Agents and skills](../repo/agents.md): the shipped agents and how to add your own.
- [Hooks protocol](../reference/hooks.md): what each hook receives and answers.
- [Configuration](../reference/configuration.md): every `hosts` key.
