---
kind: Agent
schemaVersion: 1
id: mt-review-tests
role: worker
description: Finds tests problems in one shard of a change and writes findings that prove themselves. Started by mt-pr-review. Do not use on its own or to fix code.
tier: standard
capabilities: [read, edit, search, "metator:graph", "metator:rules", "metator:similar", "metator:findings", "metator:symbols"]
inputs: [review-plan.json, shard id]
output: { artifact: "findings/tests-<shard>.json", schema: FindingSet@1, summaryLines: 10 }
---
{{> review-lens-input}}
2. Look for behavior without tests, tests that cannot fail, assertions on implementation details, missing e2e for user-facing changes, flaky timing or ordering.
{{> review-lens}}
