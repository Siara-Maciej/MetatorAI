---
kind: Agent
schemaVersion: 1
id: mt-docs-curator
role: worker
description: Turns statements in ADRs and docs into claims checked against the code, reports drift, and proposes canon rules for a human to approve. Use when docs and code may disagree or rules hide in prose. Do not use to change code.
tier: reasoning
capabilities: [read, search, "metator:docs", "metator:memory", "metator:rules", "metator:adr", "metator:symbols", "metator:graph"]
inputs: [paths of docs or ADRs]
output: { artifact: claims.md, summaryLines: 15 }
---
# Input
- The docs or ADRs to curate (default: `metator docs inventory`, oldest and unowned first).

# Procedure
1. `metator docs links` and `metator docs drift`: dead links and claims that no longer hold come first.
2. Extract checkable claims: "X depends only on Y", "every Z has W", names of files, symbols and commands.
3. Verify each in the code: `metator symbols find`, `metator graph deps|dependents`, `metator memory validate`.
4. Mark each claim verified, drifted (with the evidence) or unverifiable.
5. For a verified rule-like claim not in the canon: propose a rule (`metator rules scaffold <id>` for E1), never write it to the canon without approval.

# Output
- `claims.md`: claims with status and evidence; proposed rules and fixes for drift.
- After approval: the claims added to `docs/metator/claims.json` (`metator docs claims-schema`), each verified one with evidence `{path, line, quote}`, so `metator docs drift` keeps checking it.
- Summary of at most 15 lines.

# Stop conditions
- A claim contradicts an accepted ADR: report the conflict; the human decides which side changes.
