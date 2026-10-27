# Customize and add agents

**Goal:** one canonical definition of every agent and skill, generated for GitHub Copilot and Claude Code, checked like code.

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

## The shipped agents

The full list with roles, tiers and permissions is on [Agents and delegation](./index.md); the skills are on [Skills](./skills.md).

## Add your own

1. Copy the closest agent in `metator/agents/` and change its id, description and procedure.
2. Give it only the capabilities it needs.
3. Add it to the `delegates` of the coordinator that should start it.
4. Run `metator meta agents-lint`, `metator meta audit` and `metator generate`.
