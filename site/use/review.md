# Review a change

Two workflows review code. `mt-pr-review` reviews a pull request or a branch and publishes comments after your approval. `mt-self-review` reviews your own branch and fixes what it finds, before you open a pull request. In both, every comment quotes the code it is about, and a blocking comment has survived an attempt to refute it.

## Start a review

```text
@mt-pr-review review PR #482
```

From a terminal, pass the base to review the branch's commits. Without a base, only the uncommitted change against `HEAD` is reviewed.

```bash
metator run init --workflow mt-pr-review --task "Review the reminder service" --input base=origin/main
metator run drive --host claude
```

<WorkflowDiagram id="mt-pr-review" />

## Stages

| Stage | Who | Produces | What happens |
|---|---|---|---|
| `metadata` | `metator review metadata` | `pr.json` | the branch, commits, authors and files |
| `shard` | `metator review plan` | `review-plan.json` | the change is split into shards, one per package |
| `rules` | `mt-rule-curator` | `rulepack.md` | the rules that apply to each shard |
| `find` | one lens per shard, at most 6 at once | `findings/` | each lens writes its findings; `metator findings validate --fix` then drops findings with invented quotes and blockers without proof |
| `verify` | `metator findings merge`, then `mt-verifier` | `findings/merged.json` | duplicates across lenses are merged; an independent agent tries to refute each blocking finding |
| `judge` | `mt-judge` | `verdict.json` | the decision, from what survived |
| `approval` | you | | which comments are published, and in which format |
| `publish` | `metator findings to-github` | `comments.json` | the comments are posted |

A lens sees one package at a time, with that package's module card and rules. This works better than one pass over a large diff. The verifier starts with a clean context, and a failing test counts for more than an argument.

## Lenses

| Lens | Looks for |
|---|---|
| `logic` | wrong results, edge cases, error handling |
| `contracts` | broken API, type and data contracts between modules |
| `conventions` | violations of your rules |
| `tests` | missing, weak or implementation-coupled tests |
| `security` | injection, secrets, authorization, unsafe input |
| `equivalence` | behavior changes in a refactor; not on by default |

```bash
metator review plan --base main --lenses logic contracts tests equivalence
```

## Findings

A finding is one review claim. It has an id such as `LOGIC-007`, a lens, a severity (`blocking`, `major`, `minor` or `nit`), a location (file and line), an exact quote of the code there, and the claim.

A blocking finding must also carry:

- a trigger: the input or state that causes the problem;
- reachability: the path from a real caller to the location;
- evidence: a test, a trace or a rule. A reference to documentation alone cannot block.

`metator findings validate` checks every quote against the file and removes what does not hold. You can check one quote yourself:

```bash
metator findings check-quote packages/billing/src/invoice.ts --line 41 --quote "if (amount < 0) throw"
```

It tells you when the quote is on another line, or not in the file at all.

The verifier marks each blocking finding `confirmed`, `refuted` or `unproven`. A refuted finding cannot block.

| File in `.metator/runs/<id>/` | Holds |
|---|---|
| `review-plan.json` | the shards, each with its lenses |
| `findings/<lens>-<shard>.json` | the findings of one lens on one shard |
| `findings/merged.json` | the merged findings, with their verification |
| `verdict.json` | the judge's decision |

## Publish the comments

```bash
metator findings to-github .metator/runs/<id>/verdict.json --format natural
metator findings to-github .metator/runs/<id>/verdict.json --format labeled
```

As a reviewer, the default, you get inline comments only for confirmed blockers. Everything else goes into the summary. With `--role author`, on your own pull request, the blockers come back as a fix list instead of comments.

Posting needs your approval: the `approval` gate of the run, or `metator run approve comment --by <name>`. The hooks deny posting without it. In CI at autonomy `L2` the gate is skipped and only confirmed blockers are published ([Gates and CI](../repo/gates-ci.md)).

## Self-review

```text
@mt-pr-review self-review my branch against main
```

<WorkflowDiagram id="mt-self-review" />

`mt-self-review` runs the same review on your branch. If it confirms blockers, `mt-planner` plans fixes for those only, `mt-implementer` builds them, `metator gate quick` runs, and the review runs again. The loop ends with zero confirmed blockers, or after five rounds with a list of what is left. This workflow pushes nothing and posts nothing.

## Measure the review

A change to a review prompt can make the review worse. The golden set catches that: cases with a known answer, in `docs/metator/evals/golden/`.

```bash
metator eval run --command "scripts/review.sh {case} {out}" --repeat 3
metator eval score .metator/evals
metator eval compare evals/baseline-report.json .metator/evals/report.json
```

`eval run` runs your review command on every case and writes the scores. `eval score` recomputes them from existing outputs. `eval compare` fails when the scores got worse, so it can gate CI.
