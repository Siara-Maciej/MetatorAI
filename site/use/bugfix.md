# Bug fix

The `mt-bugfix` workflow fixes a bug with proof: a test that fails before the fix and passes after it.

## Start

```text
@mt-orchestrator run mt-bugfix for: Invoices with a 100% discount show a negative total.
```

Or from a terminal:

```bash
metator run init --workflow mt-bugfix --task "Invoices with a 100% discount show a negative total" --worktree
metator run drive --detach
```

Give the symptom, the expected behavior and how to reproduce it, if you know.

<WorkflowDiagram id="mt-bugfix" />

## What differs from a feature

The stages are those of [Feature](./feature.md), with the same two approvals. Three things change:

| Stage | Difference |
|---|---|
| `context` | `mt-diagnostician` works beside `mt-scout` and `mt-rule-curator`. It reproduces the bug and narrows the cause with hypotheses it can disprove. It writes `repro.json`: the command that fails before the fix. |
| `plan` | the first step is the regression test |
| `gates` | the gates also check that the fix adds no new import edges |

There is no `learn` stage.

## Clean up after the diagnosis

During diagnosis, every temporary log line carries a tag: `[DEBUG-`, four hex digits, `]`. Before the gates, one command proves that none is left:

```bash
metator debug-tags check --base main
```

It fails with the file, line and tag of each one it finds.

## Check that the test is stable

A regression test that passes only sometimes proves nothing.

```bash
metator flaky check packages/billing/src/discount.test.ts --runs 5
```

The command runs the test several times. Mixed results mean it is flaky, and the report includes the first failing output.

## Done

- `repro.json` fails before the fix and passes after it;
- the gates pass;
- the review has no blocking findings;
- you approved the push.
