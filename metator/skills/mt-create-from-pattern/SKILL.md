---
kind: Skill
schemaVersion: 1
name: mt-create-from-pattern
description: Use when a plan step creates a file that follows a cataloged pattern (use case, port adapter, CLI command group, versioned document, or any pattern in docs/metator/patterns). Do not use when no pattern fits; that is a new abstraction with an ADR.
---
# When
A plan step has `action: create` and a `patternSource`; or you are about to create a file and `metator similar --file <path>` names a pattern.

# Steps
1. `metator similar --file <path> --top 3`: take the pattern of the best match and its exemplar.
2. Read the pattern in `docs/metator/patterns/<id>.yml`: `intent`, `when`, `whenNot` and the canon `rules` it lists (`metator rules show <id>`).
3. Read the exemplar file whole; copy its shape: exports, constructor parameters, how errors return, how it is wired (`metator graph dependents <exemplar>` shows the registration).
4. Write the new file with the same structure and naming, only the task's logic differs.
5. Wire it where the exemplar is wired (runtime registration, index export, CLI registration) and add its tests next to the exemplar's tests.
6. `metator patterns scan` must find the new file as an occurrence of the pattern.

# Output
The new file, its wiring and tests; `patterns scan` lists it as an occurrence.

# Checklist
- [ ] the exemplar is not under the pattern's `legacy`
- [ ] the file's suffix and folder match the pattern's other occurrences
- [ ] every rule the pattern names holds (`metator rules check --files <new file>`)
- [ ] tests sit where the exemplar's tests sit

# Errors
The new file is not an occurrence after `patterns scan`: its shape differs from the detection rule; compare with the exemplar again instead of changing the rule.
