# Copilot and Claude Code

MetatorAI runs its agents through GitHub Copilot or Claude Code. This page shows which files each tool gets, how to choose the tools for a repository, and how agents are limited to the commands they need. These docs call the AI tool the host.

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

`hosts.targets` in `metator.config.yml` lists the hosts that get files. Without it, both do. The first `metator setup` writes it from what it finds: the hosts the repository already has files for, or else the hosts whose command is on your machine ([First run](./first-run.md#set-up-the-repository)).

```yaml
hosts:
  targets:
    - copilot
    - claude
```

Change it with setup, which keeps the rest of your config:

```bash
metator setup --host copilot claude --hooks --yes
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

## Drive a run on a host

In the host's chat you start a run by asking the `mt-orchestrator` agent. From a terminal, name the host that should run the agents:

```bash
metator run drive --host copilot
```

Without `--host`, the first entry of `hosts.targets` is used.

## Related

- [Agents and skills](../repo/agents.md): the shipped agents and how to add your own.
- [Hooks protocol](../reference/hooks.md): what each hook receives and answers.
- [Configuration](../reference/configuration.md): every `hosts` key.
