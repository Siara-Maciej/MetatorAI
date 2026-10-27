# Agents and delegation

MetatorAI ships a team of agents for GitHub Copilot and Claude Code. Each one has **one job**, a **model tier** and **only the tools that job needs**. Two coordinators run workflows and delegate; every other agent is a worker that does one stage and writes one artifact.

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

## How agents are defined

Every agent is a Markdown file with versioned front matter in `metator/agents/`. `metator generate` writes the host files, and `metator meta agents-lint` checks them. See [Customize and add agents](./customize.md).
