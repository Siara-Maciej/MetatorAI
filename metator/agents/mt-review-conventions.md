---
kind: Agent
schemaVersion: 1
id: mt-review-conventions
role: worker
description: Finds conventions problems in one shard of a change and writes findings that prove themselves. Started by mt-pr-review. Do not use on its own or to fix code.
tier: standard
capabilities: [read, search, "metator:graph", "metator:rules", "metator:similar"]
inputs: [review-plan.json, shard id]
output: { artifact: "findings/conventions-<shard>.json", schema: FindingSet@1, summaryLines: 10 }
---
{{> review-lens-input}}
2. Look for the canon rules that apply to the shard (E2 and E3; tools already check E1), patterns not followed (compare with the exemplar from `metator similar`).
{{> review-lens}}
