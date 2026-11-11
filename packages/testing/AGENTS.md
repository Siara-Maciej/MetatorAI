# @metator/testing

Fakes of the ports (`src/fakes.ts`) and the port contract suites (`src/contracts`).

- An adapter of a port that has a contract suite runs it in its own tests (MT-TEST-002); so does the port's fake, in `test/fakes.test.ts`. A double that only replays scripted answers (`ScriptedProcessRunner`) is exempt by name in the check.
- Fakes stay in memory and deterministic: no clock, network or real git unless a test passes one in.
