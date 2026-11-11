# Agents and skills

MetatorAI ships a set of agents and skills. Each is written once, under `metator/`, and generated for GitHub Copilot and Claude Code. This page lists them and shows how to change them, add your own and give them MCP servers.

## Coordinators and workers

Every agent has one job, a model tier and only the tools that job needs.

- A coordinator (`mt-orchestrator`, `mt-pr-review`) follows a workflow. It moves the run, hands each stage to a worker and never edits code. The [hooks](./hooks.md) deny it if it tries.
- A worker does one stage, writes one artifact (for example `analysis.json` or `plan.json`) and returns a short summary to the coordinator.

This split keeps the roles apart: the agent that writes a plan does not approve it, and the agent that writes code does not review it.

## Shipped agents

<AgentGallery />

## Shipped skills

A skill is a reusable procedure, optionally with scripts. The host loads a skill when its description matches the task, so every description says when to use it and when not to.

| Skill | Use it when | Do not use it |
|---|---|---|
| `mt-find-patterns` | a plan or an implementation creates a new file or symbol and needs the exemplar the repository already follows | for plain text search or review |
| `mt-create-from-pattern` | a plan step creates a file that follows a cataloged pattern | when no pattern fits |
| `mt-characterization-tests` | a refactor is about to start and tests must pin the current behavior | for new features or bug fixes |
| `mt-review-rubric` | a review agent decides whether something is a finding and how severe it is | to find problems in the first place |
| `mt-grill` | a task is ambiguous at intake and the run must not guess | once the plan is approved, or when the code can answer |
| `mt-diagnose` | a test, a gate or a reported bug fails and the cause is not obvious | to write the fix |
| `mt-run-without-asking` | an agent is about to run a shell or `metator` command in a run and needs the form that runs without asking a person | to decide what the task needs |

## Source files and generated files

| Source | Claude Code | Copilot |
|---|---|---|
| `metator/agents/<id>.md` | `.claude/agents/<id>.md` | `.github/agents/<id>.agent.md` |
| `metator/skills/<name>/SKILL.md` and its files | `.claude/skills/<name>/` | `.github/skills/<name>/` |

Edit only the files under `metator/`, then generate:

```bash
metator generate            # write the host files
metator generate --check    # fail when a generated file is stale or orphaned
```

`hosts.targets` in `metator.config.yml` chooses which hosts to generate for (default: `copilot` and `claude`).

## An agent file

```markdown
---
kind: Agent
schemaVersion: 1
id: mt-scout
role: worker
description: Maps what a task touches before planning, from the import graph and module cards. Use at the start of a run to scope the change. Do not use to write code or to review.
tier: standard
capabilities: [read, search, edit, "metator:graph", "metator:workspace", "metator:cards", "metator:owners"]
inputs: [task]
output: { artifact: analysis.json, schema: Analysis@1, summaryLines: 15 }
---
# Input
# Procedure
# Output
# Stop conditions
```

| Field | Meaning |
|---|---|
| `description` | hosts pick an agent by this text: say when to use it and when not |
| `role` | `coordinator` or `worker` |
| `tier` | `reasoning`, `standard` or `fast`; `hosts.models` in the configuration maps a tier to a model per host |
| `capabilities` | the tools the agent gets. `metator:graph` allows `metator graph` commands and nothing broader |
| `delegates` | for a coordinator: the only agents it may start |
| `output` | the artifact the agent writes, its schema and the length of its summary |

## Add your own agent

1. Copy the closest agent in `metator/agents/` and change its `id`, `description` and procedure.
2. Give it only the capabilities it needs.
3. Add its id to the `delegates` of the coordinator that should start it.
4. Check and generate:

```bash
metator meta agents-lint     # schema, id prefix, delegation, sections, size
metator meta audit           # the call graph: cycles, agents nothing reaches, nesting too deep
metator generate
```

`metator meta agents-schema` prints the JSON Schema of the front matter.

## Add your own skill

A skill is a directory whose name is the skill's name:

```text
metator/skills/mt-find-patterns/
├── SKILL.md            # front matter (kind: Skill, name, description) and the procedure
└── scripts/similar.sh  # optional helper the host may run
```

```bash
metator meta skills-lint     # name matches the directory, description says when and when not, files exist
metator generate
```

`metator meta skills-schema` prints the JSON Schema of the front matter.

## MCP servers for the agents

Declare the MCP servers your agents may use in the configuration. `metator generate` writes them into `.mcp.json`, which Claude Code and the Copilot CLI read.

```yaml
# metator.config.yml
mcp:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
  jira:
    url: https://mcp.example.com/jira
```

Servers that only you use go in `~/.config/metator/options.yml` under the same `mcp:` key. Write secrets as `${VAR}` references, never as values: the file is committed.

## Take a newer version of the shipped agents

When you update MetatorAI, pull its agents, skills and workflows into your repository:

```bash
metator agents update --dry-run      # what would change
metator agents update                # take it; files you changed are kept
metator agents update --theirs       # where both sides changed, take the shipped version
```

`metator/install.lock.json` records what was installed, which is how MetatorAI tells a file you changed from one you left alone. `--no-generate` leaves the host files as they are.
