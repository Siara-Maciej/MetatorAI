---
kind: Skill
schemaVersion: 1
name: mt-review-rubric
description: Use when a review lens decides whether something it found is a finding and how severe it is. Do not use to find problems in the first place or to judge the whole change.
---
# When
A lens worker (`mt-review-*`) has a candidate problem and must decide if it becomes a finding.

# Steps
1. Is it reachable? Trace a real caller to the location (`metator graph callers <symbol>`); no caller means no blocking finding.
2. What triggers it? Name the concrete input or state. No trigger means it is a question for the author, not a finding.
3. Severity: blocking (wrong result, data loss, security, broken contract on a reachable path), major (wrong in an edge case), minor (maintainability with a rule id), nit (style; usually omit).
4. Evidence: a failing test, a trace, a canon rule id or a doc citation. Blocking needs one.
5. Quote the exact code at the location; `metator findings validate` rejects a quote that is not in the file.

# Output
A finding (`metator findings schema`) with severity, trigger, reachability, evidence and quote, or nothing.

# Checklist
- [ ] not a duplicate of another lens's finding with the same root cause
- [ ] not a style preference without a rule
- [ ] confidence matches the evidence

# Errors
Not sure it is reachable: report it as major with confidence below 0.5; the verifier decides.
