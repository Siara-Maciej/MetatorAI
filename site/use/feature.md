# Feature

The `mt-feature` workflow builds a feature end to end: it surveys the code, plans, builds test-first, runs your gates, reviews the result and pushes. You approve the plan and the push.

## Start

```text
@mt-orchestrator run mt-feature for: Customers can combine a percentage and a fixed discount on one invoice.
Acceptance: discounts apply in that order; the total never goes below zero.
```

Or from a terminal:

```bash
metator run init --workflow mt-feature --task "Combine a percentage and a fixed discount" --worktree
metator run drive --detach
```

State the acceptance criteria if you have them. When the task is ambiguous, the run asks you at intake and does not guess.

<WorkflowDiagram id="mt-feature" />

## Stages

| Stage | Who | Produces | What happens |
|---|---|---|---|
| `setup` | `metator index build` | | the import index is rebuilt, so later facts are current |
| `intake` | `mt-orchestrator` | `task.md` | the task, its acceptance criteria and what is out of scope |
| `context` | `mt-scout`, `mt-pattern-miner`, `mt-rule-curator`, in parallel | `analysis.json`, `research.json`, `rulepack.md` | what the task touches, the exemplars to follow, the rules that apply |
| `plan` | `mt-planner` | `plan.json`, `plan-scope.json` | steps, each with a file, tests first and an exemplar |
| `plan-gate` | `metator plan lint`, then `mt-plan-critic` | | a deterministic check, then an independent critic |
| `plan-approval` | you | | approve, or reject with a reason |
| `build` | `mt-test-author`, then `mt-implementer` | `build-log.md` | failing tests first, then the code that passes them, only inside the plan's scope |
| `gates` | `mt-gatekeeper` | `gates.md` | `metator gate full`: the checks your repository configures |
| `review` | `mt-pr-review` | `verdict.json` | the [review](./review.md) of the change; the stage passes only on an approved verdict |
| `delivery` | you | | approve the push |
| `publish` | `mt-pr-author` | `pr.md` | commits and pushes the run's branch; opens a pull request only when the task asks for one |
| `learn` | `mt-retro` | | optional: lessons from the run |

A failed stage sends the run back: a failed plan gate or a rejected plan to `plan`, failed gates to `build`, a failed review to `plan`. Each loop has a limit (plan 2, build 2, review 3). At the limit the run is escalated and you get the open problems.

## The plan gate

`metator plan lint` checks the plan before any code is written:

```bash
metator plan lint .metator/runs/<id>/plan.json
```

It fails when:

- a created file has no exemplar (`patternSource`) and no ADR for a new pattern;
- a file is outside the task's scope;
- code comes before the tests for it;
- a step comes before a step it depends on in the import graph;
- a deleted file still has importers.

The exemplar rule keeps new code in the shape of code you already have. `metator similar --file <path>` finds candidates.

`metator plan scope` then writes `plan-scope.json`: the exact files the build may edit. The hooks deny edits outside it.

## Your two approvals

Both wait in your [inbox](./inbox.md). From a terminal:

```bash
metator run approve plan-approval --by alice
metator run approve delivery --by alice
```

At `plan-approval`, a rejection with a reason sends the plan back to the planner. This is the cheapest moment to change direction. `--choice autopilot` approves and switches the run to autonomy `L1`.

At `L1`, `plan-approval` is passed by the level and logged as such. `delivery` cannot be skipped at any level. Approving it grants the push. The publisher never force-pushes, amends or skips hooks, and the stage is done only when nothing is uncommitted and the remote branch is at the checked-out commit.

See [Gates and approvals](../guide/gates.md).

## Done

- the gates pass;
- `verdict.json` says `APPROVED`;
- you approved the push.
