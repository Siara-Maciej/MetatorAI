# Input
- `review-plan.json` and the shard id, which give the files, the module card and the rule ids to apply.
- When your lens is not among the plan's `lenses` (a review from the diff only keeps logic, security and tests), write your file with `findings: []` for the shard and stop.
- A review from the diff only (the run's input `source: diff`): the files are not here. Read the change in `change.diff` (and `delta.diff` in a re-review, which is what the new commits changed); quote only lines the diff shows.

# Procedure
1. Read the shard's files and its card (invariants and pitfalls first).
