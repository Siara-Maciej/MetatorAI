# Refactor

The `mt-refactor` workflow changes structure (split a module, extract a function, rename) and proves that behavior stayed the same.

## Start

```text
@mt-orchestrator run mt-refactor for packages/billing: split invoice.ts into calculation and formatting.
```

Name the scope in the task: the package or the files the refactor may touch. From a terminal you can also pass it as the input `scope`. The tests must be green before the run starts.

```bash
metator run init --workflow mt-refactor --task "Split invoice.ts into calculation and formatting" --input scope=packages/billing
metator run drive --detach
```

<WorkflowDiagram id="mt-refactor" />

## Stages

| Stage | Who | What happens |
|---|---|---|
| `setup` | `metator index build` | the import index is rebuilt |
| `baseline` | `metator api snapshot` | every declaration the packages export is recorded |
| `characterize` | `mt-test-author`, skill `mt-characterization-tests` | tests that pass on the old code pin today's behavior; `equivalence.md` lists the behaviors |
| `plan` | `mt-planner`, `mt-refactorer` | small steps, each citing a rule or a pattern |
| `plan-gate` | `metator plan lint`, then `mt-plan-critic` | as in [Feature](./feature.md#the-plan-gate) |
| `plan-approval` | you | approve, or reject with a reason |
| `build` | `mt-refactorer` | one step at a time; `metator gate quick` must pass after each |
| `gates` | `mt-gatekeeper` | `metator gate full`; the API is unchanged or changed only as planned; coverage is at least the baseline |
| `review` | `mt-pr-review` with the equivalence lens | looks for semantics that changed: error handling, ordering, defaults |
| `delivery` | you | approve the push |
| `publish` | `mt-pr-author` | commits and pushes the run's branch |

## Check the API yourself

```bash
metator api snapshot @shop/billing      # before
# ... refactor ...
metator api diff @shop/billing          # after: every added or removed declaration
metator graph diff --base main          # added and removed import edges, new package dependencies, new cycles
```

A refactor that only moves code can still change what other packages are able to import. `api diff` shows that line by line, before review. Without a package name, `api snapshot` covers every package that has an API.

`metator coverage diff --base main` compares the coverage of the changed lines with the baseline.

## Find every caller first

```bash
metator symbols find calculateTotal
metator graph callers calculateTotal --file packages/billing/src/invoice.ts
```

`symbols find` shows where the name is defined and re-exported. `graph callers` lists every importer of the symbol, including those that import it through a barrel file.

## Done

- the API diff is empty, or holds only planned changes;
- coverage is at least the baseline;
- the equivalence lens has no confirmed blockers;
- you approved the push.
