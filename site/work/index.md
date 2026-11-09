# Work

This section is about doing things: answering what waits for you, watching and steering sessions, asking about the code, and running the shipped workflows.

| I want to | Page |
|---|---|
| answer every question, permission and gate from one queue | [Inbox and decisions](./inbox.md) |
| see what each session does, attach to its terminal, run several side by side | [Sessions and terminals](./sessions.md) |
| ask a question about the code and get `path:line` answers | [Ask about the code](./ask.md) |
| build a feature end to end | [Feature (W1)](./feature.md) |
| fix a bug with a regression test first | [Bug fix (W2)](./bugfix.md) |
| change structure without changing behavior | [Refactor (W3)](./refactor.md) |
| review a PR, or my own branch before the PR | [Review (W4, W5)](./review.md) |
| change several applications in the right order | [System change (W13)](./system.md), a module |
| let routine runs pass some gates without me | [Autonomy and autopilot](./autonomy.md) |

## Start in chat or in a terminal

In Copilot Chat or Claude Code, a coordinator agent walks the workflow and asks you in the chat:

```text
@mt-orchestrator run mt-feature for AB#1234
@mt-orchestrator run mt-bugfix for <bug report>
@mt-orchestrator run mt-refactor for packages/billing
@mt-pr-review review PR #482
```

From a terminal, MetatorAI itself walks the stages, starts each worker through your AI host and stops at every decision that belongs to a person:

```bash
metator run                    # a new run, driven in the background and watched live
metator ui                     # every session, what needs you, terminals
```

The specs live in `.github/metator/workflows/*.yml`. Read them; they are the contract the agents follow ([Workflow](../concepts/workflow.md)).

## The life of a run

```bash
metator run init --workflow mt-feature --task "Add combined discount"   # new run, first stage
metator run status                                                      # where it is, what it expects
metator run advance pass                                                # the stage is done
metator run advance fail --reason "gates: 2 tests red"                 # loop back (bounded), or escalate
metator run approve plan-approval --by alice                           # a human gate
metator run approve push --by alice                                     # an external action
metator run checkpoint                                                  # state summary into log.md
metator run handoff                                                     # handoff.md for a colleague
metator run close                                                       # summary.json, final telemetry
```

**Why a state machine:** an agent cannot skip a stage, cannot loop forever and cannot approve itself. Every `onFail` names where to go back to and which loop limit it counts against; when the limit is reached the run is `escalated` and you get the open problems with options.

## What each run leaves on disk

```text
.metator/runs/20261026-mt-feature-add-combined-discount/
├── state.json        # RunRecord: stage, loops, approvals (written only by `metator run`)
├── log.md            # append-only audit trail: every transition, approval and checkpoint
├── activity.jsonl    # events of the drive: stages, agents, tools, questions, gates
├── analysis.json     # what the scout found the task touches
├── plan.json         # the plan, checked by `metator plan lint`
├── plan-scope.json   # the files the build may edit (the hooks enforce it)
├── findings/         # review findings per lens and shard
├── verdict.json      # the judge's decision
├── handoff.md        # from `metator run handoff`
└── summary.json      # from `metator run close`
```

The `guard subagent-output` hook validates every JSON artifact when a worker finishes, so a malformed artifact is sent back at once, not discovered three stages later.

## Resume after a break

```bash
metator run status
```

`status` gives the stage, what the stage expects and the recent history. The `guard session-start` hook puts this into the context of every new session automatically; `guard precompact` writes a checkpoint before the host compacts the conversation. 

## Write your own workflow

Copy a shipped spec and adapt it, then check it:

```bash
metator workflow schema          # the JSON Schema of a workflow
metator workflow validate        # schema of every spec
metator workflow lint            # every spec against the 16-section anatomy
```

See [Workflow](../concepts/workflow.md) for what lint requires.
