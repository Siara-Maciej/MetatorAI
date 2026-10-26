# Bug fix (W2 `mt-bugfix`)

**Use it when** something is broken and you want it fixed with proof: a test that fails before the fix and passes after.

## Start

```text
@mt-orchestrator run mt-bugfix for: Invoices with a 100% discount show a negative total (ticket AB#981).
```

## How it differs from a feature

| Stage | Difference | Why |
|---|---|---|
| context | `mt-diagnostician` runs next to the scout and rule curator | it reproduces the bug and narrows the cause with falsifiable hypotheses (skill `mt-diagnose`) |
| context artifact | `repro.json`: the command that fails before the fix | the bug is real and the fix is measurable |
| plan | the first step is the regression test | the test proves the bug, then proves the fix |
| gates | include `graph diff` | a fix should not add new dependencies between packages |

## Diagnosis without leftovers

During diagnosis temporary log lines carry one tag, `[DEBUG-` followed by four hex digits and `]`. Before the gates the cleanup is proven:

```bash
metator debug-tags check --base main
```

```json
{"ok":false,"error":{"code":"CHECK_FAILED","message":"1 debug tag(s) left in the code",
 "details":{"tags":[{"file":"src/total.ts","line":3,"tag":"[DEBUG-c0de]"}]}}}
```

## Is the test stable?

A regression test that sometimes passes is worse than none:

```bash
metator flaky check packages/billing/src/discount.test.ts --runs 5
```

Mixed results across runs mean flaky; the first failing output is in the report.

## Done means

- `repro.json` failed before the fix and passes after it;
- the gates pass;
- review found no confirmed blockers;
- the push was approved.
