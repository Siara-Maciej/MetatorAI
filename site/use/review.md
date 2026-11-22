# Review a change

Two workflows review code. `mt-pr-review` reviews a pull request or a branch and publishes comments after your approval. `mt-self-review` reviews your own branch and fixes what it finds, before you open a pull request. In both, every comment quotes the code it is about, and a blocking comment has survived an attempt to refute it.

## Start a review

```text
@mt-pr-review review PR #482
```

From a terminal, pass the base to review the branch's commits. Without a base, only the uncommitted change against `HEAD` is reviewed.

```bash
metator run new --workflow mt-pr-review --task "Review the reminder service" --input base=origin/main
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
| `approval` | you | | the publish card ("Publish the review of MR #45? (3 inline comments, 1 general)"); approving also approves posting them |
| `publish` | `metator review publish` | | the inline comments and the summary, posted in one go through the code host (a review from a link); without one, printed for `mt-pr-review` to post |

A lens sees one package at a time, with that package's module card and rules. This works better than one pass over a large diff. The verifier starts with a clean context, and a failing test counts for more than an argument.

## Review someone else's MR from its link

Paste the link in a chat: the chat agent runs `metator review open <url>`. MetatorAI reads the request through the code host set up for it, never through the agent's own tools:

1. the source in `codehost.sources` for that repository (its `via`);
2. else an MCP server named `github` or `gitlab` under `mcp:`;
3. else, for GitHub, `gh` when it is installed and logged in;
4. else the chat says: "I cannot open this MR: no code-host tool for github.com is set up (an MCP server or gh)".

GitLab is read through MCP only.

**This repository or one of the folder**: the full review above, in a worktree on the request's head (fetched from `origin`).

**Any other repository**: a review from the diff only. The logic, security and tests lenses read the diff the host gave (`change.diff` in the run's directory) and the files it shows; rules, contracts, conventions and everything that runs code are left out. The published review starts with:

```text
Reviewed from the diff only: no local checkout, so the repository's rules, contracts and tests were not used.
```

It is one workflow: its input `source` is `local` or `diff`.

**Publishing.** The review is first the agent's answer in the chat. The `approval` gate is the card **Publish the review of MR #45? (3 inline comments, 1 general)**: one Yes publishes all of it, inline where the host allows. When the host or the tool cannot comment on lines, nothing is posted: the agent says so and gives you the list, and you decide the other form. With `codehost.review.autoPublish: true` the gate is skipped.

**Watching.** A reviewed request, and one where you are a requested reviewer, is kept in `.metator/reviews/<id>.json` (`github-acme-shop-45`) and watched every `codehost.review.everyMs` (two minutes by default) for new commits and the author's replies. Watching ends when the request is merged or closed, when you approve it, or with `metator review unwatch`.

**Re-review.** New commits or a reply make one card, **MR #45: 2 new commits, 1 reply**. **Re-review** opens the agent's terminal: the lenses read only what the new commits changed (`delta.diff`), and the judge decides the state of every earlier finding (`fixed`, `not-fixed`, `disputed`, `outdated`) with a reason. MetatorAI first marks candidates: the commented code changed, the author resolved the thread, or replied in it. A candidate is a hint; only the agent's `metator review finding` sets a state.

**Approve.** When every finding is fixed, the agent proposes **All 4 findings are fixed: approve MR #45?**. Approving is yours: a Yes on the card, or your word in the chat, after which `metator review approve` runs and the guard asks you once more.

```bash
metator review open https://github.com/acme/shop/pull/45   # read it, start the review
metator review list                                        # the watched requests, finding states, what is new
metator review show github-acme-shop-45                    # its findings, their state and the candidates
metator review check                                       # read the watched requests now
metator review rereview github-acme-shop-45                # the new commits and every earlier finding
metator review approve github-acme-shop-45 --by maciej     # at the code host; the guard asks first
metator review unwatch github-acme-shop-45
```

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

`findings to-github` only formats the comments; it posts nothing and writes no file. Posting needs your approval: approving the `approval` gate of the run grants it, and `metator run approve comment --by <name>` grants it at any other time. The hooks deny posting without it. In CI at autonomy `L2` the gate is skipped and only confirmed blockers are published ([Gates and CI](../repo/gates-ci.md)).

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
