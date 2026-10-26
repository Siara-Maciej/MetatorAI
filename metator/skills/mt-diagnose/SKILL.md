---
kind: Skill
schemaVersion: 1
name: mt-diagnose
description: Use when a test, a gate or a reported bug fails and the cause is not obvious, to run a disciplined loop of hypotheses and experiments. Do not use to write the fix or when the failing assertion already names the cause.
---
# When
A red gate with an unclear cause, a bug report (W2), or a test that fails only sometimes.

# Steps
1. Reproduce: the smallest command that fails, run twice; `metator flaky check <test>` if results differ.
2. Read the failing output whole; write the exact symptom.
3. Hypotheses: at most three, each with one experiment that could refute it.
4. Run the cheapest experiment first; record the result; drop refuted hypotheses.
5. Narrow with the graph: `metator graph callers <symbol>`, `metator graph path <a> <b>`.
6. Stop when one hypothesis survives with a direct observation at `file:line`.

# Output
`diagnosis.md`: repro command and output, hypotheses with experiments and results, cause with `file:line`.

# Checklist
- [ ] the failure reproduces before any hypothesis
- [ ] each conclusion rests on an observation, not on reading code alone
- [ ] the repro command becomes the regression test

# Errors
It stops reproducing: record the last state and treat it as flaky until shown otherwise.
