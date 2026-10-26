---
kind: Skill
schemaVersion: 1
name: mt-characterization-tests
description: Use when a refactor is about to start and the current behavior must be pinned by tests that pass on the old code. Do not use for new features or bug fixes, where tests describe the wanted behavior instead.
files: [references/equivalence.md]
---
# When
The first refactor steps (W3, R1–R3): before any structural change.

# Steps
1. `metator api snapshot <package>` for every package the refactor touches.
2. List the behaviors of each function in scope: inputs and outputs, error values, side effects, ordering. Copy references/equivalence.md into the run directory as `equivalence.md` and fill its table.
3. Write tests that assert today's behavior, including odd cases; they describe what is, not what should be.
4. Run them on the unchanged code: they must pass. A failing one is a misunderstanding; fix the test, not the code.
5. `metator flaky check <test> --runs 3` for each new test file.

# Output
Green characterization tests on the old code, `equivalence.md` with every behavior and its test, API snapshots.

# Checklist
- [ ] every public function in scope has at least one test per behavior row
- [ ] error paths are covered, not only the happy path
- [ ] the tests pass on the old code and are not flaky

# Errors
Behavior that depends on time, randomness or the environment: pin it (inject the clock or the seed) before testing, or record it as not covered in `equivalence.md`.
