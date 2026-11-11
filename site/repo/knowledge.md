# Keep knowledge true

Agents read module cards, docs and lessons before they change code. This page shows how to keep those files current: generate what can be generated, cite the code for the rest, and check both in CI.

## Module cards

A card describes one package. Agents read it before they work in that package.

```bash
metator cards build          # writes docs/metator/modules/<package>.card.md
metator cards build --check  # fails when a card is missing or out of date
```

A card has a generated block and sections you write:

```markdown
<!-- metator:generated:start -->
- Directory: `packages/money`
- Depends on: none
- Used by: `@shop/billing`
- Owners: `@shop/finance`
<!-- metator:generated:end -->

## Responsibility
## Invariants
## Allowed dependencies
## Pitfalls
```

The generated block comes from the import graph and CODEOWNERS, so `cards build` rewrites it and you never edit it. The sections below it hold what only people know. Update them when you change the package.

## Citations

A statement about the code can carry a citation: a file, a line and a quote.

```markdown
- Amounts are never negative [[cite: packages/money/src/money.ts:14 | "if (amount < 0) throw"]].
```

```bash
metator memory validate          # each citation: ok, moved or stale
metator memory validate --fix    # rewrite the line numbers of quotes that moved
```

A quote that moved to another line is `moved`, and `--fix` updates it. A quote that is no longer in the file is `stale`: the statement needs a person to check it again.

## The memory map

`docs/metator/memory-map.yml` lists every knowledge file with its tier, who writes it, who reads it and a size budget.

```yaml
kind: MemoryMap
schemaVersion: 1
tierBudgets:
  T0: { chars: 4000 }
items:
  - id: t0.agents
    tier: T0
    kind: canon
    paths: ["AGENTS.md", "CLAUDE.md"]
    load: always
    writers: [human]
    readers: ["*"]
    budget: { chars: 4000, lines: 80 }
    description: Always-loaded project instructions.
```

Budgets matter most for files an agent always loads: every line of `AGENTS.md` costs context on every request. Move detail into files that load only for matching paths.

| Command | Shows |
|---|---|
| `metator memory inventory` | every knowledge file with its size and its map item (works without a map) |
| `metator memory budget` | file and tier sizes against the budgets |
| `metator memory dupes` | the same statement in several files |
| `metator memory matrix` | who reads and writes which file |
| `metator memory check` | for CI: every file mapped, budgets kept, citations true |

## Docs that drift

```bash
metator docs inventory    # every Markdown document: lines, last change, age, owners, links
metator docs links        # relative links to a missing file, directory or heading
metator docs drift        # verified claims checked against the code again
```

A claim records a statement from your docs with the code that proves it, in `docs/metator/claims.json`:

```json
{"kind":"ClaimSet","schemaVersion":1,"claims":[
  {"id":"tax.rate","source":"docs/guide.md","statement":"The tax rate is a constant.",
   "status":"verified","evidence":{"path":"src/tax.ts","line":2,"quote":"export const TAX = 0.23;"}}]}
```

When the quoted line changes, `docs drift` fails and names the claim. `docs drift --fix` updates the line of a quote that only moved.

## Lessons

At the end of a run, the `mt-retro` agent writes `retro.md` in the run's directory. It proposes lessons there, each with the command that records it. It does not run those commands. Read the file and run the ones you agree with:

```bash
metator lessons add --title "Guard negative totals" \
  --statement "Reject negative totals before any rounding." \
  --file src/total.ts --line 2 --quote "if (a < 0) throw" \
  --run 20261026-mt-bugfix-negative-total
```

The lesson is written to `docs/metator/lessons/`. `lessons add` refuses a quote that is not in the file, and `memory validate` keeps checking it afterwards.

## Owners

```bash
metator owners packages/core/src/domain/hook.ts
```

```json
{"ok":true,"data":{"source":".github/CODEOWNERS","owners":[
  {"path":"packages/core/src/domain/hook.ts","owners":["@Siara-Maciej"],"rule":{"pattern":"*","line":2}}]}}
```

The last matching line of CODEOWNERS wins, as on GitHub. Agents use the answer to name who to ask, and cards show it in the generated block.

## The quarterly review

```bash
metator meta quarterly
```

This gathers what the checks above know into one `QuarterlyReview` document under `.metator/reviews/`: rule coverage and rules that match no file, knowledge files over budget, documents and lessons nobody touched for 90 days, and dead links. It ends with a list of actions for the owners. The command decides nothing: it lists facts for people to decide on.

| Option | Default | Meaning |
|---|---|---|
| `--stale-days <days>` | `90` | a document or lesson untouched this long is stale |
| `--baseline <file>`, `--report <file>` | none | two `EvalReport` files; the review compares the current review evals with the baseline |
| `--tolerance <ratio>` | `0.02` | the drop allowed per eval number |

## Check everything in CI

`metator meta check-all` runs every check on this page in one command. See [Gates and CI](./gates-ci.md#check-the-whole-canon).
