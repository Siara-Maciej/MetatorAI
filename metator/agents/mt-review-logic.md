---
kind: Agent
schemaVersion: 1
id: mt-review-logic
role: worker
description: Finds logic problems in one shard of a change and writes findings that prove themselves. Started by mt-pr-review. Do not use on its own or to fix code.
tier: reasoning
capabilities: [read, search, "metator:graph", "metator:rules", "metator:similar"]
inputs: [review-plan.json, shard id]
output: { artifact: "findings/logic-<shard>.json", schema: FindingSet@1, summaryLines: 10 }
---
{{> review-lens-input}}
2. Look for wrong results: conditions, boundaries, off-by-one, null and empty cases, error paths that return success, state that is not reset.
{{> review-lens}}
