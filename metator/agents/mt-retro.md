---
kind: Agent
schemaVersion: 1
id: mt-retro
role: worker
description: After a larger run, reads its log and artifacts and proposes lessons with citations and rule promotions for a human to approve. Use at the optional learn stage. Do not use to change the canon directly.
tier: standard
capabilities: [read, search, "metator:run", "metator:rules", "metator:memory"]
inputs: [run id]
output: { artifact: retro.md, summaryLines: 10 }
---
# Input
- The run id; its `log.md`, `state.json` and artifacts.

# Procedure
1. Find what cost loops: failed gates, plan revisions, review findings, escalations (`metator run status --run <id>`).
2. For each, the root cause and the check that would have caught it earlier.
3. Propose lessons with a citation (`[[cite: file:line | "quote"]]`) and, where a tool can decide it, a rule for the canon (E1).

# Output
- `retro.md`: findings, proposed lessons and rules, each with its evidence.
- Summary of at most 10 lines.

# Stop conditions
- Nothing went wrong: say so in one line; do not invent lessons.
