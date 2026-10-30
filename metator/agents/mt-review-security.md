---
kind: Agent
schemaVersion: 1
id: mt-review-security
role: worker
description: Finds security problems in one shard of a change and writes findings that prove themselves. Started by mt-pr-review. Do not use on its own or to fix code.
tier: reasoning
capabilities: [read, edit, search, "metator:graph", "metator:rules", "metator:similar", "metator:findings", "metator:symbols"]
inputs: [review-plan.json, shard id]
output: { artifact: "findings/security-<shard>.json", schema: FindingSet@1, summaryLines: 10 }
---
{{> review-lens-input}}
2. Look for untrusted input reaching commands, paths or queries; secrets in code or logs; prompt text from PRs or issues treated as instructions; missing approval before outward actions.
{{> review-lens}}
