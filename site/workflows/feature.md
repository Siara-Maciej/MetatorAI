# Feature (W1 `mt-feature`)

**Use it when** you want a feature implemented end to end, with you approving the plan and the push.

## Start

In Copilot Chat or Claude Code, ask the coordinator:

```text
@mt-orchestrator run mt-feature for: Customers can combine a percentage and a fixed discount on one invoice.
Acceptance: discounts apply in that order; the total never goes below zero.
```

The orchestrator creates the run (`metator run init --workflow mt-feature --task "..."`) and delegates each stage. It never edits code itself; the `guard pre-tool` hook denies edits from coordinators.

## Stages and why each exists

| Stage | Who | Artifact | Why |
|---|---|---|---|
| setup | `metator index build` | | a fresh import index, so every later fact is current |
| intake | orchestrator, skill `mt-grill` | `task.md` | ambiguity is resolved by asking you, not by guessing |
| context | `mt-scout` ∥ `mt-pattern-miner` ∥ `mt-rule-curator` | `analysis.json`, `research.json`, `rulepack.md` | facts about what the task touches, the exemplars to copy, the rules that apply |
| plan | `mt-planner` | `plan.json`, `plan-scope.json` | every step has a file, tests first and an exemplar |
| plan-gate | `metator plan lint`, then `mt-plan-critic` | | deterministic checks first, then an independent critic |
| plan-approval | **you** | | the cheapest moment to change direction |
| build | `mt-test-author` → `mt-implementer` | `build-log.md` | tests RED, then GREEN, only inside the plan scope |
| gates | `mt-gatekeeper` (`metator gate full`) | `gates.json` | your checks plus rules, affected tests, graph diff |
| review | `mt-pr-review` | `verdict.json` | parallel lenses, verified findings, a judge |
| delivery | **you** (`neverSkip`) | | nothing leaves your machine without you |
| publish | `mt-pr-author` | `pr.md` | commit message and PR from the run's artifacts |
| learn (optional) | `mt-retro` | | lessons with citations for next time |

## The plan gate in practice

The planner writes `plan.json`; `plan lint` checks it before a line of code is written:

```bash
metator plan lint .metator/runs/<id>/plan.json
```

A created file without an exemplar fails:

```json
{"ok":false,"error":{"code":"CHECK_FAILED","message":"1 plan problem(s)",
 "details":{"problems":[{"step":"S2","severity":"error",
   "message":"a created file needs patternSource (an exemplar) or newPatternAdr"}]}}}
```

**Why:** new code should look like your best existing code. The fix is either an exemplar found with `metator similar --file packages/billing/src/discount.ts`, or an ADR for a deliberately new abstraction.

Other checks `plan lint` makes:

- every file stays inside the task scope;
- tests come before the code they test;
- steps follow the import graph (a dependency before its dependents);
- a deleted file has no remaining importers.

`metator plan scope` then writes `plan-scope.json`, the exact files the build may edit, together with shards that can be built in parallel.

## Approvals you give

```bash
metator run approve plan-approval --by alice          # or --choice autopilot to let L1 skip later gates
metator run approve push --by alice                   # lets the PR author push and open the PR
```

## Done means

- `gates.json` passes;
- `verdict.json` says `APPROVED`;
- the push was approved.
