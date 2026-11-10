# Keep knowledge true

**Goal:** everything your agents read about the code (module cards, docs, lessons) is current, cited and checked in CI.

## Module cards

```bash
metator cards build          # writes docs/metator/modules/<package>.card.md
metator cards build --check  # CI: fails when a card's generated block is stale
```

A card has a generated block and curated sections:

```markdown
<!-- metator:generated:start -->
- Directory: `packages/money`
- Depends on: none
- Used by: `@shop/billing`
- Imported by other packages: `packages/money/src/index.ts`
- Third-party: none
- Owners: `@shop/finance`
- Patterns with their exemplar here: `money-value`
<!-- metator:generated:end -->

## Responsibility
## Invariants
## Allowed dependencies
## Pitfalls
```

**Why:** the generated part never lies, because the import graph and CODEOWNERS produce it. The curated part holds what only people know. Write invariants with citations so they are checked too.

## Citations

```markdown
- Amounts are never negative [[cite: packages/money/src/money.ts:14 | "if (amount < 0) throw"]].
```

```bash
metator memory validate          # ok | moved | stale | missing-file per citation
metator memory validate --fix    # update line numbers of quotes that moved
```

## The memory map

`docs/metator/memory-map.yml` lists every knowledge file: its tier, who writes it, who reads it and its size budget.

```bash
metator memory inventory     # every knowledge file, mapped or not
metator memory budget        # sizes against budgets (always-loaded instructions stay small)
metator memory dupes         # the same statement in several files
metator memory check         # CI: every file mapped, budgets kept, citations true
```

**Why budgets:** everything an agent always loads costs context on every request. A budget keeps `AGENTS.md` small and moves details to files loaded only when needed.

## Docs that drift

```bash
metator docs inventory       # every Markdown document: lines, last commit, age, owners, links
metator docs links           # relative links to missing files or headings
metator docs drift           # verified claims in docs/metator/claims.json checked again
```

A claim records a statement from your docs with its evidence:

```json
{"kind":"ClaimSet","schemaVersion":1,"claims":[
  {"id":"tax.rate","source":"docs/guide.md","statement":"The tax rate is a constant.",
   "status":"verified","evidence":{"path":"src/tax.ts","line":2,"quote":"export const TAX = 0.23;"}}]}
```

When `src/tax.ts` changes to `0.21`, `docs drift` fails with `1 drifted`. The doc is no longer true.

## Lessons

After a run, `mt-retro` proposes lessons in the run's `retro.md` without stopping the run to ask. Each proposal comes with the command that records it; run the ones you approve:

```bash
metator lessons add --title "Guard negative totals" \
  --statement "Reject negative totals before any rounding." \
  --file src/total.ts --line 2 --quote "if (a < 0) throw" --run 20261026-mt-bugfix-negative-total
```

**Why the citation is required:** a lesson without evidence is an opinion. `lessons add` refuses a quote that is not in the code, and `memory validate` keeps checking it.

## The quarterly review

Once a quarter, one command gathers what the checks above know and turns it into a short list of decisions for the owners:

```bash
metator meta quarterly                                   # 90 days counts as stale
metator meta quarterly --stale-days 60 \
  --baseline evals/q3/report.json --report evals/q4/report.json   # also compare the review evals
```

```json
{"rules":{"active":20,"e1":20,"e1Percent":100,"dead":[],"e1WithoutTest":[],"e1Disabled":[]},
 "memory":{"items":24,"overBudget":[]},
 "docs":{"total":304,"stale":[],"deadLinks":0},
 "lessons":{"total":3,"unpromoted":[]},
 "evals":{"status":"no-baseline","hint":"pass --baseline <EvalReport> and --report <EvalReport> from `metator eval run`"},
 "actions":["commit an eval baseline so the next quarter compares against it"],
 "output":".metator/reviews/quarterly-2026-11-10.json"}
```

The review is a versioned `QuarterlyReview` document under `.metator/reviews/`. Each number comes from a command you can run alone (`rules coverage`, `memory budget`, `docs inventory`, `eval compare`), and each action names what to retire, raise or promote: rules that apply to no file, knowledge files over budget, documents nobody touched for a season, lessons older than the threshold that no rule cites, eval regressions against the baseline. The actions are also printed as warnings, so a nightly job can post them.

**Why deterministic:** the review decides nothing. It lists the facts a person needs to decide, with the same numbers CI gates on, so the quarter's decisions are about the code, not about who remembered what.

## Owners

```bash
metator owners packages/billing/src/invoice.ts
```

```json
{"source":".github/CODEOWNERS","owners":[{"path":"packages/billing/src/invoice.ts",
  "owners":["@shop/billing"],"rule":{"pattern":"/packages/billing/","line":4}}]}
```

CODEOWNERS is read where GitHub looks (`.github/`, the root, `docs/`), with GitHub's rules: the last matching line wins.
