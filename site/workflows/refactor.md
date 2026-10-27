# Refactor (W3 `mt-refactor`)

**Use it when** you change structure (split a module, extract a function, rename) and behavior must stay exactly the same.

## Start

```text
@mt-orchestrator run mt-refactor for packages/billing: split invoice.ts into calculation and formatting.
```

<WorkflowDiagram id="mt-refactor" />

## How behavior is proven unchanged

| Step | Command or skill | What it proves |
|---|---|---|
| API baseline | `metator api snapshot @shop/billing` | records every declaration the package exports |
| characterization | skill `mt-characterization-tests` | tests that pass on the **old** code pin today's behavior; `equivalence.md` lists behaviors per function |
| small steps | `mt-refactorer`, `metator gate quick` after each step | every step keeps the tests green |
| API unchanged | `metator api diff @shop/billing` | any added or removed declaration fails |
| no new coupling | `metator graph diff --base main` | new cross-package edges or new import cycles show up |
| review | lens `mt-review-equivalence` | looks for semantics that changed (error handling, ordering, defaults) |

```bash
metator api snapshot @shop/billing      # before
# ... refactor ...
metator api diff @shop/billing          # after: {"changed":false} or every changed line
metator graph diff --base main          # added and removed edges, new package dependencies, new cycles
```

**Why the API snapshot:** a refactor that "only moved code" sometimes changes what other packages can import. The diff shows it line by line, before review.

## Find every caller first

```bash
metator symbols find calculateTotal             # where the name is defined (and re-exported)
metator graph callers calculateTotal --file packages/billing/src/invoice.ts   # every importer, also through barrels
```

## Done means

- the API diff is empty, or contains only planned changes;
- coverage of the changed lines is at least the baseline (`metator coverage diff`);
- the equivalence lens has no confirmed blockers;
- the push was approved.
