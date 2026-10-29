# Workflows and runs

A workflow turns "implement this" into stages with owners, artifacts and gates. MetatorAI ships six:

| Workflow | Use it for | Start in chat |
|---|---|---|
| [`mt-feature` (W1)](./feature.md) | a new feature end to end | ask `mt-orchestrator`: "run mt-feature for AB#1234" |
| [`mt-bugfix` (W2)](./bugfix.md) | a bug, with a regression test that reproduces it first | ask `mt-orchestrator` with the bug report |
| [`mt-refactor` (W3)](./refactor.md) | changing structure without changing behavior | ask `mt-orchestrator` with the scope |
| [`mt-pr-review` (W4)](./review.md) | reviewing a PR, interactively or in CI | ask `mt-pr-review` with the PR |
| [`mt-self-review` (W5)](./review.md#self-review-w5) | fixing your own branch before you open the PR | ask `mt-pr-review` in self-review mode |
| [`mt-system-change` (W13)](./system.md) | a change across several applications and repositories | ask `mt-orchestrator` with the task |

The specs live in `.github/metator/workflows/*.yml`. Read them; they are the contract the agents follow.

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

**Why a state machine:** an agent cannot skip a stage, cannot loop forever and cannot approve itself. The rules are in the spec:

- every `onFail` names where to go back to and which loop limit it counts against;
- when the limit is reached the run is `escalated` and you get the open problems with options.

## What each run leaves on disk

```text
.metator/runs/20261026-mt-feature-add-combined-discount/
├── state.json        # RunRecord: stage, loops, approvals (written only by `metator run`)
├── log.md            # append-only audit trail: every transition, approval and checkpoint
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

`status` gives the stage, what the stage expects and the recent history. The `guard session-start` hook puts this into the context of every new session automatically. The `guard precompact` hook writes a checkpoint before the host compacts the conversation, so nothing depends on chat memory.

## Autonomy

| Level | Use it when | What changes |
|---|---|---|
| `L0` (default) | you want to see every gate | every human gate asks you |
| `L1` (autopilot) | routine work you trust | gates with `skipAt: [L1]` (for example the plan approval) are approved by the autonomy level and logged |
| `L2` | headless review in CI | no interactive gates; only confirmed blockers are published |

```bash
metator run init --workflow mt-feature --task "Bump retry limit" --autonomy L1
metator run approve plan-approval --by alice --choice autopilot   # switch an L0 run to L1
```

Pushing and commenting still need `metator run approve push|comment` at every level.

## Write your own workflow

Copy a shipped spec and adapt it, then check it:

```bash
metator workflow schema          # the JSON Schema of a workflow
metator workflow validate        # schema of every spec
metator workflow lint            # every spec against the 16-section anatomy
```

`workflow lint` requires every workflow to answer:

- **start:** entry, input contract, preconditions;
- **stages:** stages with owners, artifacts, gates, parallelism, loops;
- **control:** escalation, autonomy, permissions;
- **finish:** definition of done, recovery, resume;
- **reporting:** telemetry, final report.

It also checks that every owner and critic is a real agent or skill.
