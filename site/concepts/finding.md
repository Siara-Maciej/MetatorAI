# Finding

A finding is one review claim with evidence: an exact quote that exists in the code, a triggering input, and the path by which the code is reached from a real caller. A finding without evidence cannot block. A blocking finding is handed to an independent verifier that tries to refute it before you ever see it.

## Why it exists

AI review fails in two ways: comments that are confidently wrong, and silence on the bug that matters. Evidence makes the first kind checkable by a script; parallel review lenses and a verifier on a different model give recall without flooding the PR. Review quality is measured on a golden set, so a prompt change that makes it worse turns CI red.

## Where it lives

| File | What |
|---|---|
| `.metator/runs/<id>/review-plan.json` | the diff sharded by package, each shard with its module card and rule pack |
| `.metator/runs/<id>/findings/<lens>-<shard>.json` | a `FindingSet` per lens and shard: logic, contracts, conventions, tests, security, equivalence |
| `.metator/runs/<id>/verdict.json` | the judge's decision after verification: what blocks, what was verified correct |
| `docs/metator/evals/golden/` | the golden set: `EvalCase` files, seeded cases with their patches under `patches/` |
| `.metator/evals/` | the scores of a run of the set |

## How a review runs

1. **Plan**: `review plan` shards the diff by module.
2. **Find**: lenses run in parallel, one per shard, and write findings.
3. **Validate**: `findings validate` drops invented quotes and unproven blockers before anyone reads them.
4. **Verify**: `mt-verifier`, on another model with a clean context, tries to refute each blocking finding; a failing test beats an argument.
5. **Judge**: `mt-judge` calibrates what survived and records the decision.
6. **Publish**: `findings to-github` posts only confirmed blockers as comments, the rest in a summary; a person approves the comments first.

## Commands

```bash
metator review plan --base main                       # shards with card and rules, lenses per shard
metator findings validate <dir> --fix                 # invented quotes and unproven blockers never reach a human
metator findings check-quote src/a.ts --line 41 --quote "…"   # one claimed quote against the code
metator findings verdict                              # merge, calibrate, decide
metator eval seed --mutants mutants.json --seeded 30 --bugs 10 --clean 10   # the golden set from what the repo knows
metator eval list                                              # the cases by type
metator eval run --command "scripts/review.sh {case} {out}"   # precision and recall on the golden set
metator eval compare                                  # fails CI when review got worse
```

## Where the golden set comes from

`metator eval seed` writes cases from what the repository already knows, so the set reaches fifty cases before anyone hand-writes one. **Seeded** cases plant the unit suite's mutants (`scripts/mutants.ts`, the bugs the tests are proven to catch) on the base commit as a patch: a review must find the planted bug at the planted line. **Bug** cases are the commits a later fix repaired: the lines the fix removed are blamed, and when they come from one commit, that commit against its parent is the case and the removed lines are what a review had to find. **Clean** cases are ordinary commits that touch code and look like no fix: a review must not block them. `eval run` turns a seeded case's patch into a commit in a temporary worktree, so the reviewer sees a real `{head}`. In MetatorAI `bun run golden:seed` does it from `scripts/mutants.ts`.

## What enforces it

- A blocking finding must carry a quote, a trigger and a reachability path; `findings validate` removes the rest.
- Only confirmed blockers block; `verdict.json` says which were verified correct and which were refuted.
- Review lenses read with Read, Glob and Grep and their own `metator` commands; the verifier alone gets a shell, to run the test that refutes a finding.
- `eval compare` is a regression gate on precision, recall, false blocks and decision variance.

## One example

```json
{"id":"logic-billing-001","severity":"blocking","rule":"MT-CODE-004",
 "claim":"roundHalfEven is applied before the discount, so a 0.005 cent difference survives",
 "evidence":{"path":"packages/billing/src/vat.ts","line":41,"quote":"return roundHalfEven(net * rate, 2);"},
 "trigger":"net=10.005, rate=0.23, discount=0.5",
 "reach":"apps/api/src/checkout.ts:88 → invoice.total() → vat()",
 "verification":{"status":"confirmed","by":"mt-verifier","test":"packages/billing/test/vat.test.ts"}}
```

## Related

- [Review a PR](../work/review.md): running it, in chat and in CI.
- [Canon](./canon.md): the rules a finding cites.
