# Agents and skills

MetatorAI ships a set of agents and skills. Each is written once, under `metator/`, and generated for GitHub Copilot and Claude Code. This page lists them and shows how to change them, add your own and give them MCP servers.

## Coordinators and workers

Every agent has one job, a model tier and only the tools that job needs.

- A coordinator (`mt-orchestrator`, `mt-pr-review`) follows a workflow. It moves the run, hands each stage to a worker and never edits code. The [hooks](./hooks.md) deny it if it tries.
- A worker does one stage, writes one artifact (for example `analysis.json` or `plan.json`) and returns a short summary to the coordinator.
- The conversation agent (`mt-chat`) is the chat you open to start work. It has a free agent's tools: it answers, edits directly what is not meant for a commit, and starts quick runs and full runs. It suggests the way and you decide; it never commits or pushes by itself. See [Chats and the three ways](../use/start.md#the-three-ways).

This split keeps the roles apart: the agent that writes a plan does not approve it, and the agent that writes code does not review it.

## Shipped agents

<AgentGallery />

## Shipped skills

A skill is a reusable procedure, optionally with reference files. The host loads a skill when its description matches the task, so every description says what the skill does, when to use it and when not to.

| Skill | What it does | Use it when | Do not use it |
|---|---|---|---|
| `mt-find-patterns` | finds the exemplar the repository already follows, with its pattern and why it fits | a plan or an implementation creates a new file or symbol | for plain text search or review; to write the file, `mt-create-from-pattern` |
| `mt-create-from-pattern` | creates a file in the shape of a pattern's exemplar: structure, naming, wiring, tests | a plan step creates a file that follows a cataloged pattern | when no pattern fits (a new abstraction, with an ADR) |
| `mt-characterization-tests` | pins today's behavior through the public interface, each test seen red once on a deliberate change | a refactor is about to start | for new features or bug fixes |
| `mt-review-rubric` | decides whether a candidate becomes a finding and how severe, from reachability, trigger, evidence and a quote | a review agent has a candidate problem | to find problems in the first place |
| `mt-grill` | asks the person in rounds, each question with a recommended answer, until no decision is assumed | a task is ambiguous at intake and the run must not guess | once the plan is approved, or for a fact the code can answer |
| `mt-diagnose` | finds a cause through a feedback loop that goes red on the bug, then ranked falsifiable hypotheses | a test, a gate or a reported bug fails and the cause is not obvious | to write the fix |
| `mt-read-java` | reads facts about Java code from the `metator java` command that measures them, cited as `path:line` ([Java repositories](../guide/java.md#read-a-java-repository)) | a question or a task needs facts about a Java repository | for TypeScript code, or to change Java code |
| `mt-run-without-asking` | picks the form of a command that runs in a run without asking a person | an agent is about to run a shell or `metator` command in a run | to decide what the task needs |
| `mt-write-skill` | writes or revises a skill to the MT-SKILL rules and Anthropic's guidance, starting from three scenarios | a skill is created, edited or reviewed | for an agent definition or a rule of the code |

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

`metator meta schema agents` prints the JSON Schema of the front matter.

## Add your own skill

A skill is a directory whose name is the skill's name:

```text
metator/skills/mt-diagnose/
├── SKILL.md                      # front matter (kind: Skill, name, description, files) and the procedure
└── references/feedback-loops.md  # read only when a step says so
```

Before you write one, use the skill `mt-write-skill`: it holds the guidance no tool can check (a concise body, a step that ends on a checkable result, facts versus decisions, good and bad examples, the scenarios to try the skill on first).

`metator meta skills-lint` checks every skill against the rules of the area `SKILL` (`metator rules show MT-SKILL-001` prints one), and names the rule in each problem, e.g. `[MT-SKILL-002] description must say when not to use it ("Do not use …")`:

| Rule | What the lint checks |
|---|---|
| `MT-SKILL-001` Name | kebab-case, at most 64 characters, the same as its directory, starts with `mt-`, never contains `claude` or `anthropic` |
| `MT-SKILL-002` Description | at most 1024 characters, no `<` or `>`; opens with what the skill does in the third person (never "Use when", "Use it", "I", "You", "We" or "This skill"), then "Use when …" and "Do not use …" |
| `MT-SKILL-003` Body | the sections When, Steps, Output, Checklist, Errors (or Kiedy, Kroki, Wyjście, Checklista, Błędy) in that order, Steps right after When, at most 300 lines |
| `MT-SKILL-004` Supporting files | every file in `files` exists and the body names it; every `scripts/`, `references/` or `assets/` path the body uses is listed; forward slashes; a reference names no other supporting file (one level deep); a Markdown file over 100 lines has `## Contents` in its first 10 lines |
| `MT-SKILL-005` Skills it names | every "skill mt-xxx" it names is a skill in `metator/skills` |

```bash
metator meta skills-lint     # the rules MT-SKILL-001..005
metator generate
```

`metator meta schema skills` prints the JSON Schema of the front matter. In your repository, `metator setup` reports problems in skills of your own as a warning (`checks[].theirs`) and still finishes.

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

## Take a newer version of the shipped files

When you update MetatorAI, pull its agents, skills and workflows into your repository:

```bash
metator agents update --dry-run      # what would change
metator agents update                # take it; files you changed are kept
metator agents update --theirs       # where both sides changed, take the shipped version
```

`metator/install.lock.json` records what was installed, which is how MetatorAI tells a file you changed from one you left alone. `--no-generate` leaves the host files as they are.
