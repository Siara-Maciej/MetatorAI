---
kind: Skill
schemaVersion: 1
name: mt-find-patterns
description: Finds the exemplar the repository already follows for a planned file or symbol, with its pattern, the path:line to copy and why it fits. Use when a plan or an implementation creates a new file or symbol. Do not use for plain text search or for review; to write the file once the exemplar is known, use skill mt-create-from-pattern.
---
# When
Planning or implementing a new file or function: reuse is checked before a symbol is created.

# Steps
1. `metator similar --file <planned path> --top 3` (or a description of the symbol): the top matches with their pattern and exemplar.
2. Drop matches the pattern catalog lists under `legacy`.
3. Pick one exemplar and say why it fits: the same layer, then the same suffix, then the same package. Between equal candidates, take the one more files already follow (`metator patterns scan` counts the occurrences).
4. No pattern fits: the step is a new abstraction and needs `newPatternAdr` (an ADR draft).
   Done when the step has one exemplar that is an occurrence in the pattern index, or a `newPatternAdr`.

# Output
`patternSource: { pattern, exemplar: "path:line", reason }` for the plan step (`metator plan schema`).

# Checklist
- [ ] the exemplar is an occurrence in the pattern index (`metator plan lint` checks it)
- [ ] not legacy
- [ ] no fit: `newPatternAdr`, and the exemplar field left empty

# Errors
An empty result or a stale index: `metator patterns scan`, then repeat.
