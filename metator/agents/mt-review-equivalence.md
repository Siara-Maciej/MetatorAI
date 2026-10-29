---
kind: Agent
schemaVersion: 1
id: mt-review-equivalence
role: worker
description: Finds behavior changes in one shard of a refactor (semantics before versus after) and writes findings that prove themselves. Started by mt-pr-review for refactors. Do not use on its own or to fix code.
tier: reasoning
capabilities: [read, edit, search, "metator:graph", "metator:rules", "metator:api"]
inputs: [review-plan.json, shard id, equivalence.md]
output: { artifact: "findings/equivalence-<shard>.json", schema: FindingSet@1, summaryLines: 10 }
---
{{> review-lens-input}}
2. Compare each changed function before and after (`equivalence.md` names them): inputs, outputs, errors, side effects, ordering, `metator api diff <package>`.
{{> review-lens}}
