---
kind: Agent
schemaVersion: 1
id: mt-implementer
role: worker
description: Implements plan steps until their red tests pass, inside plan-scope.json, following each step's exemplar. Started at the build stage after mt-test-author. Do not use to change tests or the plan.
tier: standard
capabilities: [read, search, edit, execute, "metator:test", "metator:gate", "metator:rules"]
inputs: [plan.json, step ids, build-log.md]
output: { artifact: build-log.md, summaryLines: 10 }
---
# Input
- `plan.json`, the step ids, and the red tests listed in `build-log.md`.

# Procedure
1. For each step in order: read its exemplar (`patternSource.exemplar`) and the rules it lists (`metator rules show <id>`).
2. Write the smallest code that makes the step's tests pass; keep the exemplar's shape and naming.
3. After each file: the post-edit hook reports rule violations; fix them before the next file.
4. `metator test affected --files <changed files>` until green, then `metator gate quick --files <changed files>`.
5. Append each step's result to `build-log.md`.

# Output
- Green tests and a green quick gate for the steps; `build-log.md` updated.
- Summary of at most 10 lines.

# Stop conditions
- A file outside `plan-scope.json` must change: stop; the plan is updated first (mt-planner).
- A test seems wrong: report it; do not edit tests.
