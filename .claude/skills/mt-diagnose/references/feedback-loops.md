# Feedback loops

A loop is one command you can run unattended that goes **red** on this bug and green once it is fixed. Build the first one that reaches the bug, in this order:

1. A failing test at whatever seam reaches the bug: unit, integration or e2e, run with the repository's test runner on that one file (`metator test affected --files <file>` runs the tests a file reaches).
2. An HTTP call against a running dev server (`metator env up` starts the repository's services), diffed against the expected response.
3. The CLI with a fixture input, its output diffed against a known-good snapshot.
4. A headless browser script (Playwright) that drives the UI and asserts on the DOM, the console or the network.
5. A replay: save a real request, payload or event log to a file and push it through the code path alone.
6. A throwaway harness: the smallest part of the system (one service, the rest faked) that runs the failing path with one call.
7. A property loop: for "sometimes wrong output", many generated inputs until one fails.
8. A bisection: when the bug appeared between two known states (commits, datasets, versions), automate "set up state X, check" and run `git bisect run` with it, in a scratch worktree.
9. A differential loop: the same input through the old and the new version (or two configurations), outputs diffed.

## Tight
Once a loop exists, make it tight before using it:
- faster: cache the setup, skip unrelated initialisation, narrow the test scope;
- sharper: assert the specific symptom, not "did not crash";
- deterministic: pin the clock, seed the randomness, isolate the file system, freeze the network.

A 30-second flaky loop is barely better than none; a 2-second deterministic one finds the cause.

## Flaky bugs
The aim is a higher reproduction rate, not a clean repro: run the trigger many times, in parallel, under load, with sleeps that widen the timing window. A bug that fails half the time can be diagnosed; one in a hundred cannot yet, so raise the rate first.
