# @metator/testing

Fakes of the ports (`src/fakes.ts`) and the port contract suites (`src/contracts`).

- Every adapter of a port runs the port's contract suite in its own tests (MT-TEST-002); a fake must pass it too.
- Fakes stay in memory and deterministic: no clock, network or real git unless a test passes one in.
