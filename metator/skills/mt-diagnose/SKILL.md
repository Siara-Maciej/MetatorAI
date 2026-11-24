---
kind: Skill
schemaVersion: 1
name: mt-diagnose
description: Finds the cause of a failure through a tight feedback loop that goes red on it, then ranked falsifiable hypotheses tested one variable at a time, ending at file:line. Use when a test, a gate or a reported bug fails and the cause is not obvious. Do not use to write the fix, or when the failing assertion already names the cause.
files: [references/feedback-loops.md]
---
# When
A red gate with an unclear cause, a bug report (W2), or a test that fails only sometimes. The loop is the skill: with one command that goes red on this bug, the cause is found by measuring; without it, only guessed.

# Steps
1. **Build the loop.** One command that drives the failing code path and asserts the exact symptom reported, not "runs without error". Ways to build one, in order, and how to make it tight: references/feedback-loops.md.
   Gate: no red command, no hypothesis. Reading code to build a theory before the command exists is the failure this skill prevents.
   Done when you have run it and seen it go red, and it is tight: seconds, the same verdict every run (`metator flaky check <test>` when results differ; for a flaky bug, a pinned reproduction rate).
2. **Reproduce and minimise.** Check it fails with the symptom that was reported, not a neighbouring one: the wrong bug gets the wrong fix. Then cut inputs, callers, configuration and data one at a time, rerunning after each cut.
   Done when every remaining element is load-bearing: removing any one makes the loop green.
3. **Hypothesise.** Three to five ranked hypotheses, each with its prediction: "If X is the cause, changing Y makes the loop green." A hypothesis without a prediction is dropped or sharpened. Narrow with the graph: `metator graph callers <symbol>`, `metator graph path <a> <b>`. Write the ranked list into `diagnosis.md` before testing; a person reading it may re-rank it, and you go on without waiting.
4. **Test them.** The cheapest experiment first, one variable per experiment. Temporary log lines carry one tag, `[DEBUG-` plus four hex digits and `]`. Record each result and drop the refuted hypotheses.
   Done when one hypothesis survives with a direct observation at `file:line`.
5. **Name the seam.** The minimised loop becomes the regression test at the seam where the bug happens, through the real call path. When no such seam exists (only a test too shallow to replicate the chain), write that down as a finding: the structure keeps this bug from being locked down.

# Output
`diagnosis.md`: the loop command and its red output, the minimised repro, the ranked hypotheses with predictions and results, the cause at `file:line`, and the seam for the regression test (or why there is none).

# Checklist
- [ ] the loop went red on the reported symptom before the first hypothesis
- [ ] the repro is minimal: removing any element turns it green
- [ ] each conclusion rests on an observation, not on reading code alone
- [ ] `metator debug-tags check --base <base>` passes: every instrumentation line is gone

# Errors
- No loop can be built: finish with `STATUS: blocked: <what you tried; what would make a loop: access to the environment that reproduces it, a captured artifact, or temporary instrumentation>`. A hypothesis without a loop is a guess.
- It stops reproducing: record the last state and treat it as flaky until shown otherwise.
