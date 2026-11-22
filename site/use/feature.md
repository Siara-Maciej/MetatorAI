# Feature

The `mt-feature` workflow builds a feature end to end: it surveys the code, plans, builds test-first, runs your gates, reviews the result and pushes. You approve the plan and the push.

## Start

In a chat, describe the feature; the agent suggests `mt-feature` when it is more than a quick change, or name it yourself:

```text
› use mt-feature: customers can combine a percentage and a fixed discount on one invoice.
  Acceptance: discounts apply in that order; the total never goes below zero.
```

Or from a terminal:

```bash
metator run new --workflow mt-feature --task "Combine a percentage and a fixed discount" --worktree
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
| `build` | `mt-test-author`, then `mt-implementer` | `build-log.md`, `build-progress.json` | failing tests first, then the code that passes them, only inside the plan's scope; the stage passes only when every step's own tests passed |
| `gates` | `mt-gatekeeper` | `gates.md` | `metator gate full`: the checks your repository configures |
| `review` | `mt-pr-review` | `verdict.json` | the [review](./review.md) of the change; the stage passes only on an approved verdict |
| `delivery` | you | | approve the push |
| `publish` | `mt-pr-author` | `pr.md` | commits and pushes the run's branch; opens a pull request only when the task asks for one |
| `learn` | `mt-retro` | | optional: lessons from the run; if it fails, the stage is skipped and the run still ends done |

A failed stage sends the run back: a failed plan gate or a rejected plan to `plan`, a step that did not pass or failed gates to `build`, a failed review to `plan`. Each loop has a limit (plan 2, build 2, review 3). At the limit the run is escalated and you get the open problems.

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

## Checkpoints in the build

The build is checked step by step, not only at the end. When `mt-implementer` finishes a step, it runs:

```bash
metator plan done .metator/runs/<id>/plan.json S3
```

That runs the tests the step's file and its tests-first reach (through your `test` script) and records the result, with the command and the end of its output, in `build-progress.json` next to the plan. A red step fails with that output; a step whose dependencies have not passed is refused before anything runs. So a bug written into one step stops that step, instead of surfacing in the gates stage after the whole build.

The build stage itself passes only when every step passed:

```bash
metator plan progress .metator/runs/<id>/plan.json --check
```

Without `--check` it lists each step as `passed`, `failed` or `pending`. The gates stage after the build still runs your full gate, so a step that passed and was broken by a later one is caught there.

## Your two approvals

Both wait on [Home](./inbox.md). From a terminal:

```bash
metator run approve plan-approval --by alice
metator run approve delivery --by alice
```

At `plan-approval`, a rejection with a reason sends the plan back to the planner. This is the cheapest moment to change direction. `--choice autopilot` approves and switches the run to autonomy `L1`.

At `L1`, `plan-approval` is passed by the level and logged as such. `delivery` cannot be skipped at any level. Approving it grants the push. The publisher never force-pushes, amends or skips hooks, and the stage is done only when nothing is uncommitted and the remote branch is at the checked-out commit.

See [Approvals and consent](./approvals.md).

## Done

- the gates pass;
- `verdict.json` says `APPROVED`;
- you approved the push.
