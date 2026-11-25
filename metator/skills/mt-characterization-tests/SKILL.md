---
kind: Skill
schemaVersion: 1
name: mt-characterization-tests
description: Pins the current behavior of the code a refactor will touch with tests that pass on the old code, through its public interface, each proven able to go red. Use when a refactor is about to start and its behavior must stay the same. Do not use for new features or bug fixes, where tests describe the wanted behavior instead.
files: [references/equivalence.md]
---
# When
The first refactor steps (W3, R1–R3): before any structural change. The tests describe what is, not what should be.

# Steps
1. `metator api snapshot <package>` for every package the refactor touches.
2. List the behaviors of each function in scope: inputs and outputs, error values, side effects, ordering. Copy references/equivalence.md into the run directory as `equivalence.md` and fill its table.
   Done when every public function in scope has its rows.
3. Write tests that assert today's behavior through the public interface the refactor keeps (the exported function, the port, the command), including the odd cases. A test that reaches into a private helper, or replaces an internal collaborator with a mock, breaks with the refactor it is meant to guard; fake only what crosses the process boundary (time, network, file system).
4. Run them on the unchanged code: they pass. A failing one is a misunderstanding of today's behavior: fix the test, keep the code.
5. Prove each test can go red: change the behavior it pins once in the code (Edit), run it and watch it fail, then restore the code exactly. A test that stays green is decoration: sharpen its assertion.
   Done when every test has been seen red once and green again, and the code is back as it was.
6. `metator flaky check <test> --runs 3` for each new test file.

# Output
Green characterization tests on the old code, `equivalence.md` with every behavior and its test, the API snapshots.

# Checklist
- [ ] every public function in scope has at least one test per behavior row
- [ ] error paths are covered, not only the happy path
- [ ] every test went red once on a deliberate change, and the code is restored
- [ ] the tests pass on the old code and are not flaky

# Errors
Behavior that depends on time, randomness or the environment: pin it (inject the clock or the seed) before testing, or record it as not covered in `equivalence.md`.
