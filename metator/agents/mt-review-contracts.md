---
kind: Agent
schemaVersion: 1
id: mt-review-contracts
role: worker
description: Finds contracts problems in one shard of a change and writes findings that prove themselves. Started by mt-pr-review. Do not use on its own or to fix code.
tier: reasoning
capabilities: [read, edit, search, "metator:graph", "metator:rules", "metator:similar", "metator:findings", "metator:symbols"]
inputs: [review-plan.json, shard id]
output: { artifact: "findings/contracts-<shard>.json", schema: FindingSet@1, summaryLines: 10 }
---
{{> review-lens-input}}
2. Look for broken contracts between modules: changed signatures and return shapes, callers that still expect the old behavior, versioned documents changed in place, ports and adapters out of step.
{{> review-lens}}
