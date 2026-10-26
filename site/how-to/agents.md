# Agents and skills

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

| Agent | Role | Does |
|---|---|---|
| `mt-orchestrator` | coordinator | runs feature, bug fix, refactor and docs workflows; delegates every stage |
| `mt-pr-review` | coordinator | runs the review core: shards, lenses, verification, verdict |
| `mt-scout` | worker | maps what a task touches (graph, cards, owners) |
| `mt-pattern-miner` | worker | finds the exemplar to copy for every planned file |
| `mt-rule-curator` | worker | collects the rules that apply to the files in scope |
| `mt-planner` | worker | writes `plan.json`: files, exemplars, rules, tests first |
| `mt-plan-critic` | worker | reviews the plan for what `plan lint` cannot see |
| `mt-test-author` | worker | writes the failing tests a step lists |
| `mt-implementer` | worker | makes them pass, inside the plan scope |
| `mt-refactorer` | worker | changes structure in small, proven steps |
| `mt-diagnostician` | worker | reproduces a bug and narrows its cause |
| `mt-gatekeeper` | worker | runs the gates and reports what is red |
| `mt-pr-author` | worker | writes the commit and PR, pushes after approval |
| `mt-review-logic` | worker | review lens: logic |
| `mt-review-contracts` | worker | review lens: contracts |
| `mt-review-conventions` | worker | review lens: your rule canon |
| `mt-review-tests` | worker | review lens: tests |
| `mt-review-security` | worker | review lens: security |
| `mt-review-equivalence` | worker | review lens: behavior changes in refactors |
| `mt-verifier` | worker | tries to refute one finding |
| `mt-judge` | worker | calibrates findings and records the decision |
| `mt-retro` | worker | proposes lessons with citations after a run |
| `mt-docs-curator` | worker | turns docs into verified claims and rule proposals |

## Skills

| Skill | Use it when |
|---|---|
| `mt-find-patterns` | a plan creates a file and needs the exemplar |
| `mt-create-from-pattern` | a step creates a file that follows a cataloged pattern |
| `mt-characterization-tests` | a refactor must pin today's behavior first |
| `mt-review-rubric` | a lens decides whether something is a finding and how severe |
| `mt-grill` | a task is ambiguous at intake |
| `mt-diagnose` | a failure's cause is not obvious |

```bash
metator meta skills-lint      # trigger and anti-trigger in the description, referenced files exist
```

## Add your own

1. Copy the closest agent in `metator/agents/` and change its id, description and procedure.
2. Give it only the capabilities it needs.
3. Add it to the `delegates` of the coordinator that should start it.
4. Run `metator meta agents-lint`, `metator meta audit` and `metator generate`.
