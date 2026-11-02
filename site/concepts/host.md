# Host

A host is the AI tool that runs the agents: GitHub Copilot or Claude Code today, OpenCode next. MetatorAI writes its agents, skills and hooks once, in a host-neutral canon, and generates the files each host expects.

## Why it exists

Teams use more than one AI tool, and the tools change faster than a team's conventions. The canon makes the agents and the guardrails the same on every host; the host is a plugin. Nothing in a workflow asks for a specific host, only for capabilities such as `read`, `metator:graph` or a shell.

## Where it lives

| Source | Claude Code | GitHub Copilot | OpenCode (planned) |
|---|---|---|---|
| `metator/agents/<id>.md` | `.claude/agents/<id>.md` | `.github/agents/<id>.agent.md` | agent files of the host |
| `metator/skills/<name>/SKILL.md` | `.claude/skills/<name>/` | `.github/skills/<name>/` | skills of the host |
| hooks (`metator guard …`) | `.claude/settings.json` | `.github/hooks/metator.json` | a plugin that calls the same commands |
| `metator.config.yml` → `hosts.targets` | which hosts get files; `hosts.models` maps agent tiers to models | | |

## Commands

```bash
metator setup --host claude --hooks       # choose hosts, install the canon, generate the files
metator generate                          # agents, skills and hooks for every target host
metator generate --check                  # CI: a generated file was edited by hand, or is stale
metator agents update                     # take a newer canon; files you changed are kept
metator run drive --host copilot          # drive a run on a host, from the terminal
```

## Least privilege

An agent's `capabilities` become the host's tool allowlist. `metator:graph` becomes `Bash(metator graph:*)`, never `Bash(*)`. A coordinator gets `Agent(<its workers>)`, not a general agent. Review lenses read; only the verifier gets a shell. Searching the repository through the shell is allowed without asking when every part of the command only reads; anything that writes goes to a person.

## What enforces it

- Hooks run outside the model: the host calls `metator guard pre-tool` before every tool use and `post-edit` after every edit; the agent cannot skip or rewrite them.
- `generate --check` fails CI when a generated file drifts from the canon.
- `meta agents-lint` checks every delegation: the agent exists, its coordinator allows it, there are no cycles.
- A run has one live drive at a time; the host denies an agent the commands that would move the run itself.

## One example

```yaml
# metator/agents/mt-scout.md (front matter)
capabilities: [read, search, "metator:graph", "metator:workspace", "metator:cards", "metator:owners"]
```

```text
# generated .claude/agents/mt-scout.md
tools: Read, Glob, Grep, Bash(metator graph:*), Bash(metator workspace:*), Bash(metator cards:*), Bash(metator owners:*)
```

## Related

- [Agents and skills](../knowledge/agents.md): the shipped team and how to add your own.
- [Hooks and guardrails](../knowledge/hooks.md), [Hooks protocol](../reference/hooks.md).
- [Session](./session.md): the worktree and drive a host works in.
