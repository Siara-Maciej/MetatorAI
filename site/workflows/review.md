# Review (W4 `mt-pr-review`, W5 `mt-self-review`)

**Use it when** you want a review you can trust: every comment quotes the code, explains how it is reached, and survived an attempt to refute it.

## Start

```text
@mt-pr-review review PR #482
@mt-pr-review self-review my branch against main
```

From a terminal, the branch's own commits are reviewed when the run gets the base; without it, only the uncommitted change against `HEAD`:

```bash
metator run init --workflow mt-pr-review --task "Review the reminder service" --input base=origin/main
metator run drive --host claude
```

<WorkflowDiagram id="mt-pr-review" />

## The review core

```text
meta    metator review metadata --base main      → pr.json: branch, commits, authors, files, uncommitted work
plan    metator review plan --base main          → shards per package, with its card and rules
find    lens × shard in parallel (max 6)         → findings/<lens>-<shard>.json
check   metator findings validate <dir> --fix    → invented quotes and unproven blockers dropped
merge   metator findings merge <dir>             → duplicates across lenses merged
verify  mt-verifier per blocking/major finding    → confirmed | refuted | unproven
judge   metator findings verdict <dir>, mt-judge  → verdict.json
```

**Resuming is safe.** A run that stops and continues runs `findings merge` again; the verifications already recorded for the same finding (same id, file and quote) stay in `merged.json`, so the verify stage is not lost. Paths may be relative or absolute inside the repository.

**Why sharding:** a lens that sees one package at a time, with that package's card and rules, reasons better than one that sees a 3,000-line diff.

**Why a verifier:** review comments that sound right and are wrong cost more than they save. An independent agent with a clean context tries to refute each finding; a failing test beats an argument.

## What a finding must contain

Every finding quotes the code and names its location. A blocking finding also needs:

- a trigger (the input that breaks it);
- reachability (the caller path to it);
- evidence.

`findings validate` checks quotes against the code. A single quote can be checked directly:

```bash
metator findings check-quote packages/billing/src/invoice.ts --line 41 --quote "if (amount < 0) throw"
# moved:  "quote is on line 44 of packages/billing/src/invoice.ts, not 41"
# stale:  "quote not found in packages/billing/src/invoice.ts"
```

## Lenses

| Lens | Looks for |
|---|---|
| logic | wrong results, edge cases, error handling |
| contracts | broken API, type and data contracts between modules |
| conventions | violations of your rule canon |
| tests | missing, weak or implementation-coupled tests |
| security | injection, secrets, authorization, unsafe input |
| equivalence | behavior changes in refactors (add with `--lenses`) |

```bash
metator review plan --base main --lenses logic contracts tests equivalence
```

## Publishing

```bash
metator findings to-github .metator/runs/<id>/verdict.json --format natural
metator findings to-github .metator/runs/<id>/verdict.json --format labeled   # [blocking] LOGIC-001: ...
```

- **Reviewer (default):** inline comments only for confirmed blockers; everything else goes in the summary.
- **Author** (`--role author`): on your own PR there are no comments to yourself; the blockers come back as a fix list for the self-review loop.

Posting needs `metator run approve comment --by <you>`; the hook denies it otherwise. In CI at L2 only confirmed blockers are published.

## Self-review (W5)

Before you open a PR, let the loop fix what it finds:

```text
first-review → plan (confirmed blockers only) → build → gates → review → ... (max 5 rounds)
```

<WorkflowDiagram id="mt-self-review" />

There is no push and no comment in this loop. Done means zero confirmed blockers, or an escalation with the list of what is left.

## Measure the review

```bash
metator eval run --command "scripts/review.sh {case} {out}" --repeat 3   # writes .metator/evals/report.json
metator eval score .metator/evals                                         # recompute scores from existing outputs
metator eval compare evals/baseline-report.json .metator/evals/report.json   # fails when the scores got worse
```

**Why:** a prompt change that makes review worse should turn CI red, like a code change that breaks a test.
