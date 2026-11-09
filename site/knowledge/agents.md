# Agents and skills

MetatorAI ships a team of agents for GitHub Copilot, Claude Code and OpenCode. Each one has **one job**, a **model tier** and **only the tools that job needs**. Two coordinators run workflows and delegate; every other agent is a worker that does one stage and writes one artifact. All of them are written once, in `metator/agents/`, and generated for every host.

<AgentGraph />

## Why a team and not one big agent

| One general agent | MetatorAI's team |
|---|---|
| One long prompt that tries to do everything | short instructions per job, easy to review and test |
| Writes its own plan and approves it | a planner writes, a critic and `plan lint` check, you approve |
| Writes the code and the tests that fit it | the test author writes failing tests first, the implementer makes them pass |
| Reviews its own work | separate lenses find problems, an independent verifier tries to refute them |
| Has every tool | each agent gets an allowlist: `Bash(metator graph:*)`, not `Bash(*)` |

## Coordinators and workers

- **Coordinators** (`mt-orchestrator`, `mt-pr-review`) follow a workflow spec. They call `metator run …` to move the run, hand each stage to a worker with a goal, input paths and an output path, and never edit code: `guard pre-tool` denies it.
- **Workers** do one stage, write one artifact (`analysis.json`, `plan.json`, `findings/*.json` …) and return a short summary. The `guard subagent-output` hook validates the artifact when the worker stops.

## All agents

<AgentGallery />

The skills, reusable procedures with optional scripts, are on [Skills](./skills.md).

## Where they live

| Source | Generated for Claude Code | Generated for Copilot |
|---|---|---|
| `metator/agents/<id>.md` | `.claude/agents/<id>.md` | `.github/agents/<id>.agent.md` |
| `metator/skills/<name>/SKILL.md` (+ scripts) | `.claude/skills/<name>/` | `.github/skills/<name>/` |

```bash
metator generate            # write the host files
metator generate --check    # CI: fail when a generated file was edited or is stale
```

Edit only the canonical files. Every generated file starts with a comment that names its source.

## A canonical agent

```markdown
---
kind: Agent
schemaVersion: 1
id: mt-scout
role: worker
description: Maps what a task touches before planning, from the import graph and module cards. Use at the start of a run to scope the change. Do not use to write code or to review.
tier: standard
capabilities: [read, search, "metator:graph", "metator:workspace", "metator:cards", "metator:owners"]
output: { artifact: analysis.json, schema: Analysis@1, summaryLines: 15 }
---
# Input
# Procedure
# Output
# Stop conditions
```

| Field | Why |
|---|---|
| `description` | hosts pick an agent by this text: say when to use it and when not |
| `role` | coordinators delegate and never edit; workers do one stage |
| `tier` | `reasoning`, `standard` or `fast`, mapped to models per host in `hosts.models` |
| `capabilities` | least privilege: `metator:graph` becomes `Bash(metator graph:*)`, nothing broader |
| `delegates` | for coordinators: the only agents they may start |

```bash
metator meta agents-lint     # schema, prefix, delegation (known, allowed, acyclic), sections, size
metator meta audit           # call graph: cycles, dead agents, nesting deeper than 2
metator meta agents-schema   # the JSON Schema
```

## Add your own

1. Copy the closest agent in `metator/agents/` and change its id, description and procedure.
2. Give it only the capabilities it needs.
3. Add it to the `delegates` of the coordinator that should start it.
4. Run `metator meta agents-lint`, `metator meta audit` and `metator generate`.

## Take a newer canon later

```bash
metator agents update --dry-run      # what would change
metator agents update                # take it; files you changed are kept
metator agents update --theirs       # take the canon's version where both sides changed
```

Each file is created, updated, kept (you changed it, the canon did not) or reported as a conflict; the lock in `metator/install.lock.json` is how MetatorAI tells "untouched" from "changed here".

## Next

- [Host](../concepts/host.md): how capabilities become tool allowlists.
- [Hooks and guardrails](./hooks.md).
